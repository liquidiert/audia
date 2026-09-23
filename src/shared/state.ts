import type {
  AppEvent,
  BaseOrder,
  Candidate,
  DerivedState,
  PlaylistEntry,
  SessionConfig,
  Song,
} from "./types";

export const DEFAULT_SKIP_VOTES = 5;

/**
 * Deterministically derive rounds, live tally and playlist from the event log.
 *
 * Every peer runs this over the same set of events and gets the same result,
 * so there is no leader: the "close" of a round is just a point in time.
 *
 * Rules:
 * - Round r covers [epoch + r·roundMs, epoch + (r+1)·roundMs). It is final once
 *   `graceMs` has passed after its end.
 * - At close, the candidate with the most votes (> 0) is appended to the
 *   playlist. Ties: earlier proposal, then lower song id.
 * - The winner leaves the pool and its votes are consumed. All other votes roll
 *   over into the next round.
 * - A voter's latest vote per song wins; only their `maxVotes` most recent
 *   active votes count.
 * - If `maxQueue` songs are already queued or playing, the round is held (no
 *   close) and votes keep rolling.
 * - Songs play back to back: startAt = max(closedAt, previous endAt).
 * - A skip vote counts only while its entry is playing. When `skipVotes`
 *   distinct voters have asked, the entry ends at that moment and everything
 *   after it moves up.
 * - An `end` event from the session's host (and only the host) ends the session:
 *   later events are ignored, no more rounds close, the playing song stops and
 *   songs that hadn't started are dropped.
 * - Base playlist (host only): when a round closes without any voted song and
 *   the queue would run dry before the next round closes, a song from the base
 *   playlist is queued instead. With "shuffle" (default) the pick is random but
 *   seeded by session and round, so every peer picks the same one, and songs
 *   that already played are avoided until the whole list has had its turn. With
 *   "ordered" the song after the last base song plays, wrapping at the end.
 */
export function derive(
  events: Iterable<AppEvent>,
  cfg: SessionConfig,
  now: number,
): DerivedState {
  const all = [...events].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const endedAt: number | null = cfg.host ? (all.find((e) => e.k === "end" && e.by === cfg.host)?.ts ?? null) : null;
  const sorted = all.filter((e) => e.k !== "end" && (endedAt === null || e.ts <= endedAt));

  const pool = new Map<string, { song: Song; proposedAt: number; proposedBy: string }>();
  const wonAt = new Map<string, number>();
  const latest = new Map<string, Map<string, { on: boolean; ts: number }>>();
  const playlist: PlaylistEntry[] = [];

  const skipThreshold = Math.max(1, cfg.skipVotes ?? DEFAULT_SKIP_VOTES);

  // Base playlist sets arrive in parts; a set takes effect once it's complete.
  const baseParts = new Map<string, Map<number, Extract<AppEvent, { k: "base" }>>>();
  // Declared via `as` so TypeScript doesn't narrow it to `null` (it's assigned inside closures).
  let base = null as { name: string; songs: Song[] } | null;
  let baseOrder: BaseOrder = "shuffle";

  const addBasePart = (e: Extract<AppEvent, { k: "base" }>) => {
    if (!cfg.host || e.by !== cfg.host) return;
    let parts = baseParts.get(e.set);
    if (!parts) baseParts.set(e.set, (parts = new Map()));
    if (parts.has(e.part) || (parts.size && [...parts.values()][0]!.total !== e.total)) return;
    parts.set(e.part, e);
    if (parts.size < e.total) return;
    const ordered = [...parts.values()].sort((a, b) => a.part - b.part);
    const songs = ordered.flatMap((p) => p.songs);
    base = songs.length ? { name: ordered[0]!.name, songs } : null;
  };

  const pickBase = (r: number): Song | null => {
    if (!base) return null;
    if (baseOrder === "ordered") {
      const songs = base.songs;
      const lastBase = playlist.findLast((p) => p.source === "base");
      const start = lastBase ? songs.findIndex((s) => s.id === lastBase.song.id) + 1 : 0;
      for (let k = 0; k < songs.length; k++) {
        const song = songs[(start + k) % songs.length]!;
        // Don't play the same song twice in a row (e.g. it was just voted in).
        if (song.id !== playlist.at(-1)?.song.id || songs.length === 1) return song;
      }
    }
    const played = new Set(playlist.map((p) => p.song.id));
    let options = base.songs.filter((s) => !played.has(s.id));
    // Everything had its turn: start over, but don't repeat the song that just played.
    if (!options.length) options = base.songs.filter((s) => s.id !== playlist.at(-1)?.song.id);
    if (!options.length) options = base.songs;
    return options[Math.floor(seededRandom(`${cfg.topic}:${r}`) * options.length)]!;
  };

  const skip = (e: Extract<AppEvent, { k: "skip" }>) => {
    const i = playlist.findIndex((p) => p.round === e.round && p.song.id === e.songId);
    const entry = playlist[i];
    if (!entry || entry.skipped || e.ts < entry.startAt || e.ts >= entry.endAt) return;
    if (entry.skippers.includes(e.by)) return;
    entry.skippers.push(e.by);
    if (entry.skippers.length < skipThreshold) return;
    entry.skipped = true;
    entry.endAt = e.ts;
    // Events arrive in time order, so later entries haven't started yet: just reflow them.
    for (let j = i + 1; j < playlist.length; j++) {
      const p = playlist[j]!;
      p.startAt = Math.max(p.closedAt, playlist[j - 1]!.endAt);
      p.endAt = p.startAt + p.song.durationS * 1000;
    }
  };

  const apply = (e: AppEvent) => {
    if (e.k === "end") return;
    if (e.k === "base") {
      addBasePart(e);
    } else if (e.k === "base-order") {
      if (cfg.host && e.by === cfg.host) baseOrder = e.order;
    } else if (e.k === "skip") {
      skip(e);
    } else if (e.k === "propose") {
      if (!pool.has(e.song.id) && e.ts >= (wonAt.get(e.song.id) ?? -Infinity)) {
        pool.set(e.song.id, { song: e.song, proposedAt: e.ts, proposedBy: e.by });
      }
    } else {
      let mine = latest.get(e.by);
      if (!mine) latest.set(e.by, (mine = new Map()));
      mine.set(e.songId, { on: e.on, ts: e.ts });
    }
  };

  const tally = (): Candidate[] => {
    const counts = new Map<string, string[]>();
    for (const [voter, votes] of latest) {
      const active: { songId: string; ts: number }[] = [];
      for (const [songId, v] of votes) {
        if (v.on && pool.has(songId) && v.ts >= (wonAt.get(songId) ?? -Infinity)) {
          active.push({ songId, ts: v.ts });
        }
      }
      active.sort((a, b) => b.ts - a.ts);
      for (const { songId } of active.slice(0, cfg.maxVotes)) {
        const list = counts.get(songId) ?? [];
        list.push(voter);
        counts.set(songId, list);
      }
    }
    return [...pool.entries()]
      .map(([songId, p]) => {
        const voters = counts.get(songId) ?? [];
        return { ...p, votes: voters.length, voters };
      })
      .sort(
        (a, b) =>
          b.votes - a.votes ||
          a.proposedAt - b.proposedAt ||
          (a.song.id < b.song.id ? -1 : a.song.id > b.song.id ? 1 : 0),
      );
  };

  const queuedAt = (t: number) => playlist.filter((p) => p.endAt > t).length;
  const roundEnd = (r: number) => cfg.epoch + (r + 1) * cfg.roundMs;
  const currentRound = Math.max(0, Math.floor((now - cfg.epoch) / cfg.roundMs));

  let i = 0;
  let r = 0;
  while (roundEnd(r) + cfg.graceMs <= now && (endedAt === null || roundEnd(r) <= endedAt)) {
    const boundary = roundEnd(r);
    while (i < sorted.length && sorted[i]!.ts < boundary) apply(sorted[i++]!);

    const queue = (song: Song, votes: number, source: PlaylistEntry["source"]) => {
      const startAt = Math.max(boundary, playlist.at(-1)?.endAt ?? 0);
      playlist.push({
        song,
        round: r,
        votes,
        closedAt: boundary,
        startAt,
        endAt: startAt + song.durationS * 1000,
        skippers: [],
        skipped: false,
        source,
      });
    };

    if (queuedAt(boundary) < cfg.maxQueue) {
      const winner = tally()[0];
      if (winner && winner.votes > 0) {
        queue(winner.song, winner.votes, "vote");
        pool.delete(winner.song.id);
        wonAt.set(winner.song.id, boundary);
      } else if ((playlist.at(-1)?.endAt ?? 0) < roundEnd(r + 1)) {
        // Nobody voted and the music would stop before the next round closes.
        const fill = pickBase(r);
        if (fill) queue(fill, 0, "base");
      }
    }

    // Nothing to vote on: skip ahead to the next round where something can happen,
    // i.e. the next event, or (with a base playlist) when the queue needs a refill.
    if (pool.size === 0) {
      const next = sorted[i];
      let target = next ? Math.floor((next.ts - cfg.epoch) / cfg.roundMs) : currentRound;
      if (base) {
        const lastEnd = playlist.at(-1)?.endAt ?? 0;
        target = Math.min(target, Math.floor((lastEnd - cfg.epoch) / cfg.roundMs) - 1);
      }
      r = Math.max(r + 1, Math.min(target, currentRound));
    } else {
      r++;
    }
  }

  while (i < sorted.length && sorted[i]!.ts <= now) apply(sorted[i++]!);

  if (endedAt !== null && endedAt <= now) {
    // Drop what never started; cut what was playing.
    const kept = playlist.filter((p) => p.startAt < endedAt);
    for (const p of kept) p.endAt = Math.min(p.endAt, endedAt);
    playlist.splice(0, playlist.length, ...kept);
  }

  const endsAt = roundEnd(r);
  const current = playlist.find((p) => p.startAt <= now && now < p.endAt);
  return {
    round: {
      index: r,
      startsAt: endsAt - cfg.roundMs,
      endsAt,
      held: queuedAt(endsAt) >= cfg.maxQueue,
    },
    candidates: tally(),
    playlist,
    nowPlaying: current ? { entry: current, positionMs: now - current.startAt } : null,
    endedAt: endedAt !== null && endedAt <= now ? endedAt : null,
    base: base ? { name: base.name, songs: base.songs.length } : null,
    baseOrder,
  };
}

/** Deterministic value in [0, 1) from a string (FNV-1a hash into mulberry32). */
export function seededRandom(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  let t = (h + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Song ids the given voter currently has an active (counting) vote on. */
export function votesOf(state: DerivedState, voter: string): Set<string> {
  return new Set(state.candidates.filter((c) => c.voters.includes(voter)).map((c) => c.song.id));
}

/**
 * Songs worth keeping after the party, in play order: everything that actually
 * started playing by `now` (voted or from the base playlist), except songs the
 * crowd skipped, each video once.
 */
export function keepers(playlist: PlaylistEntry[], now = Infinity): Song[] {
  const seen = new Set<string>();
  return playlist
    .filter((p) => p.startAt <= now && !p.skipped && !seen.has(p.song.id) && seen.add(p.song.id))
    .map((p) => p.song);
}
