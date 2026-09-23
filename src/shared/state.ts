import type {
  AppEvent,
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
    if (e.k === "skip") {
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

    if (queuedAt(boundary) < cfg.maxQueue) {
      const winner = tally()[0];
      if (winner && winner.votes > 0) {
        const prevEnd = playlist.at(-1)?.endAt ?? 0;
        const startAt = Math.max(boundary, prevEnd);
        playlist.push({
          song: winner.song,
          round: r,
          votes: winner.votes,
          closedAt: boundary,
          startAt,
          endAt: startAt + winner.song.durationS * 1000,
          skippers: [],
          skipped: false,
        });
        pool.delete(winner.song.id);
        wonAt.set(winner.song.id, boundary);
      }
    }

    // Nothing to vote on: skip ahead to the round of the next event.
    if (pool.size === 0) {
      const next = sorted[i];
      const target = next ? Math.floor((next.ts - cfg.epoch) / cfg.roundMs) : currentRound;
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
  };
}

/** Song ids the given voter currently has an active (counting) vote on. */
export function votesOf(state: DerivedState, voter: string): Set<string> {
  return new Set(state.candidates.filter((c) => c.voters.includes(voter)).map((c) => c.song.id));
}

/**
 * Songs worth keeping after the party, in play order: everything that made the
 * playlist except songs the crowd skipped, each video once.
 */
export function keepers(playlist: PlaylistEntry[]): Song[] {
  const seen = new Set<string>();
  return playlist.filter((p) => !p.skipped && !seen.has(p.song.id) && seen.add(p.song.id)).map((p) => p.song);
}
