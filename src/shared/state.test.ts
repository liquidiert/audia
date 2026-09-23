import { describe, expect, test } from "bun:test";
import { derive, keepers, votesOf } from "./state";
import { chunkEvents, decodeTicket, decodeWire, encodeTicket, newSessionConfig, validEvent } from "./protocol";
import type { AppEvent, Song } from "./types";

const cfg = newSessionConfig({ epoch: 0, roundMs: 1000, graceMs: 100, maxVotes: 2, maxQueue: 10 });
const song = (id: string, durationS = 10): Song => ({ id, title: id, artist: "a", durationS });
let n = 0;
const propose = (id: string, ts: number, by = "p", durationS = 10): AppEvent => ({
  k: "propose", id: `e${n++}`, by, ts, sig: "", song: song(id, durationS),
});
const vote = (songId: string, by: string, ts: number, on = true): AppEvent => ({
  k: "vote", id: `e${n++}`, by, ts, sig: "", songId, on,
});
const skip = (songId: string, round: number, by: string, ts: number): AppEvent => ({
  k: "skip", id: `e${n++}`, by, ts, sig: "", songId, round,
});

describe("derive", () => {
  test("live tally before any round closes", () => {
    const s = derive([propose("x", 10), vote("x", "u1", 20), vote("x", "u2", 30), propose("y", 40)], cfg, 500);
    expect(s.round.index).toBe(0);
    expect(s.candidates.map((c) => [c.song.id, c.votes])).toEqual([["x", 2], ["y", 0]]);
    expect(s.playlist).toEqual([]);
  });

  test("round closes after grace and winner is scheduled", () => {
    const ev = [propose("x", 10), vote("x", "u1", 20), propose("y", 30), vote("y", "u1", 40), vote("y", "u2", 50)];
    expect(derive(ev, cfg, 1050).playlist).toHaveLength(0); // within grace
    const s = derive(ev, cfg, 1200);
    expect(s.playlist.map((p) => p.song.id)).toEqual(["y"]);
    expect(s.playlist[0]!.startAt).toBe(1000);
    expect(s.nowPlaying?.entry.song.id).toBe("y");
    expect(s.nowPlaying?.positionMs).toBe(200);
    // loser's votes roll over
    expect(s.candidates.map((c) => [c.song.id, c.votes])).toEqual([["x", 1]]);
  });

  test("votes after the boundary count for the next round", () => {
    const ev = [propose("x", 10), vote("x", "u1", 20), propose("y", 30), vote("y", "u1", 1010), vote("y", "u2", 1020)];
    const s = derive(ev, cfg, 2200);
    expect(s.playlist.map((p) => p.song.id)).toEqual(["x", "y"]);
    expect(s.playlist[1]!.startAt).toBe(s.playlist[0]!.endAt);
  });

  test("ties go to the earlier proposal", () => {
    const ev = [propose("b", 10), propose("a", 20), vote("a", "u1", 30), vote("b", "u2", 40)];
    expect(derive(ev, cfg, 1200).playlist[0]!.song.id).toBe("b");
  });

  test("latest vote per song wins, and only maxVotes most recent count", () => {
    const ev = [
      propose("a", 1), propose("b", 2), propose("c", 3),
      vote("a", "u", 10), vote("b", "u", 20), vote("c", "u", 30), // a is pushed out (maxVotes = 2)
      vote("b", "v", 40), vote("b", "v", 50, false), // v retracted
    ];
    const s = derive(ev, cfg, 500);
    expect(Object.fromEntries(s.candidates.map((c) => [c.song.id, c.votes]))).toEqual({ a: 0, b: 1, c: 1 });
    expect([...votesOf(s, "u")].sort()).toEqual(["b", "c"]);
  });

  test("winner's votes are consumed; re-proposal starts fresh", () => {
    const ev = [propose("x", 10), vote("x", "u1", 20), propose("x", 1500), vote("y", "u9", 1600)];
    const s = derive(ev, cfg, 1700);
    expect(s.playlist).toHaveLength(1);
    expect(s.candidates.map((c) => [c.song.id, c.votes])).toEqual([["x", 0]]);
  });

  test("rounds are held while the queue is full", () => {
    const c = { ...cfg, maxQueue: 1 };
    const ev = [propose("x", 10, "p", 5), vote("x", "u", 20), propose("y", 30), vote("y", "u", 40)];
    // x closes at 1000 and plays until 6000; rounds ending at 2000..5000 are held.
    const held = derive(ev, c, 3500);
    expect(held.playlist.map((p) => p.song.id)).toEqual(["x"]);
    expect(held.round.held).toBe(true);
    const later = derive(ev, c, 7200);
    expect(later.playlist.map((p) => p.song.id)).toEqual(["x", "y"]);
    expect(later.playlist[1]!.closedAt).toBe(6000);
  });

  test("empty stretches are skipped and event order does not matter", () => {
    const ev = [vote("x", "u", 100_050), propose("x", 100_010)];
    const a = derive(ev, cfg, 101_500);
    const b = derive([...ev].reverse(), cfg, 101_500);
    expect(a).toEqual(b);
    expect(a.playlist[0]!.closedAt).toBe(101_000);
  });
});

describe("skip votes", () => {
  const c = { ...cfg, skipVotes: 3 };
  // x wins round 0 (plays 1000..11000), y wins round 1 and queues behind it.
  const base = [propose("x", 10), vote("x", "u", 20), propose("y", 1010), vote("y", "u", 1020)];

  test("below the threshold nothing changes, but skippers are tracked", () => {
    const s = derive([...base, skip("x", 0, "a", 2000), skip("x", 0, "b", 2100)], c, 3000);
    expect(s.nowPlaying?.entry.song.id).toBe("x");
    expect(s.nowPlaying?.entry.skippers).toEqual(["a", "b"]);
    expect(s.playlist[0]!.endAt).toBe(11_000);
  });

  test("reaching the threshold ends the song and moves the queue up", () => {
    const s = derive([...base, skip("x", 0, "a", 2000), skip("x", 0, "b", 2100), skip("x", 0, "c", 2500)], c, 3000);
    expect(s.playlist[0]).toMatchObject({ skipped: true, endAt: 2500 });
    expect(s.playlist[1]).toMatchObject({ song: { id: "y" }, startAt: 2500, endAt: 12_500 });
    expect(s.nowPlaying?.entry.song.id).toBe("y");
    expect(s.nowPlaying?.positionMs).toBe(500);
  });

  test("duplicate voters count once; votes outside the playing window are ignored", () => {
    const s = derive(
      [
        ...base,
        skip("y", 1, "a", 2000), // y is queued, not playing yet
        skip("x", 0, "a", 2000),
        skip("x", 0, "a", 2100),
        skip("x", 0, "b", 2200),
        skip("x", 5, "c", 2300), // wrong round
      ],
      c,
      3000,
    );
    expect(s.playlist[0]!.skippers).toEqual(["a", "b"]);
    expect(s.playlist[0]!.skipped).toBe(false);
    expect(s.playlist[1]!.skippers).toEqual([]);
  });

  test("a skip frees the queue so a held round can close earlier", () => {
    const held = { ...c, maxQueue: 1 };
    const ev = [...base, skip("x", 0, "a", 1500), skip("x", 0, "b", 1600), skip("x", 0, "c", 1700)];
    // Without skips, y would wait until x ends at 11000; now it closes at the 2000 boundary.
    const s = derive(ev, held, 2200);
    expect(s.playlist.map((p) => [p.song.id, p.closedAt, p.startAt])).toEqual([["x", 1000, 1000], ["y", 2000, 2000]]);
  });

  test("defaults to 5 skip votes for sessions created before skips existed", () => {
    const { skipVotes, ...old } = c;
    const four = ["a", "b", "c", "d"].map((by, i) => skip("x", 0, by, 2000 + i));
    expect(derive([...base, ...four], old, 3000).playlist[0]!.skipped).toBe(false);
    expect(derive([...base, ...four, skip("x", 0, "e", 2100)], old, 3000).playlist[0]!.skipped).toBe(true);
  });
});

describe("ending the session", () => {
  const c = { ...cfg, host: "host" };
  const end = (by: string, ts: number): AppEvent => ({ k: "end", id: `e${n++}`, by, ts, sig: "" });
  // x plays 1000..11000, y is queued behind it.
  const base = [propose("x", 10), vote("x", "u", 20), propose("y", 1010), vote("y", "u", 1020)];

  test("the host's end stops the music, drops unplayed songs and freezes everything", () => {
    const ev = [...base, end("host", 3000), propose("z", 3100), vote("z", "u", 3200), skip("x", 0, "u", 3300)];
    const s = derive(ev, c, 60_000);
    expect(s.endedAt).toBe(3000);
    expect(s.nowPlaying).toBeNull();
    expect(s.playlist.map((p) => [p.song.id, p.endAt])).toEqual([["x", 3000]]);
    expect(s.candidates.map((c) => c.song.id)).not.toContain("z");
  });

  test("before the end time nothing changes", () => {
    const s = derive([...base, end("host", 3000)], c, 2500);
    expect(s.endedAt).toBeNull();
    expect(s.nowPlaying?.entry.song.id).toBe("x");
  });

  test("anyone else's end event is ignored, as are ends in sessions without a host", () => {
    expect(derive([...base, end("guest", 3000)], c, 60_000).endedAt).toBeNull();
    expect(derive([...base, end("host", 3000)], cfg, 60_000).endedAt).toBeNull();
  });

  test("the earliest end wins", () => {
    expect(derive([...base, end("host", 5000), end("host", 3000)], c, 60_000).endedAt).toBe(3000);
  });
});

describe("base playlist", () => {
  const c = { ...cfg, host: "host", maxQueue: 3 };
  let set = 0;
  const baseSet = (ts: number, ids: string[], by = "host", partSize = 2): AppEvent[] => {
    const id = `set${set++}`;
    const parts = Math.max(1, Math.ceil(ids.length / partSize));
    return Array.from({ length: parts }, (_, part) => ({
      k: "base" as const, id: `e${n++}`, by, ts, sig: "", set: id, part, total: parts, name: "Wedding classics",
      songs: ids.slice(part * partSize, (part + 1) * partSize).map((x) => song(x, 5)),
    }));
  };
  const ids = ["b1", "b2", "b3", "b4", "b5"];

  test("fills silence with base songs, back to back, without repeats", () => {
    // Songs are 5s, rounds 1s: a base song is queued whenever the queue would run dry.
    const s = derive(baseSet(0, ids), c, 30_500);
    expect(s.base).toEqual({ name: "Wedding classics", songs: 5 });
    expect(s.playlist.every((p) => p.source === "base" && p.votes === 0)).toBe(true);
    for (let j = 1; j < s.playlist.length; j++) expect(s.playlist[j]!.startAt).toBe(s.playlist[j - 1]!.endAt);
    const firstFive = s.playlist.slice(0, 5).map((p) => p.song.id);
    expect(new Set(firstFive).size).toBe(5);
    expect(s.nowPlaying?.entry.source).toBe("base");
  });

  test("the pick is the same on every peer (seeded by session and round)", () => {
    const ev = baseSet(0, ids);
    const a = derive(ev, c, 20_500).playlist.map((p) => p.song.id);
    const b = derive([...ev].reverse(), { ...c }, 20_500).playlist.map((p) => p.song.id);
    expect(a).toEqual(b);
    const other = derive(ev, { ...c, topic: "another session" }, 20_500).playlist.map((p) => p.song.id);
    expect(other).not.toEqual(a);
  });

  test("a voted song wins over the base playlist", () => {
    const ev = [...baseSet(0, ids), propose("x", 10), vote("x", "u", 20)];
    const s = derive(ev, c, 1200);
    expect(s.playlist.map((p) => [p.song.id, p.source])).toEqual([["x", "vote"]]);
  });

  test("with votes queued there's no base filler until the queue runs dry", () => {
    // x plays 1000..11000 (10s song); base only resumes for the round that closes before 11000 would leave silence.
    const ev = [...baseSet(0, ids), propose("x", 10), vote("x", "u", 20)];
    const s = derive(ev, c, 12_500);
    expect(s.playlist[0]!.song.id).toBe("x");
    expect(s.playlist[1]).toMatchObject({ source: "base", startAt: 11_000 });
    expect(s.playlist.filter((p) => p.source === "base").length).toBeLessThanOrEqual(2);
  });

  test("incomplete sets, guests and removal", () => {
    const partial = baseSet(0, ids).slice(0, 1);
    expect(derive(partial, c, 5000).base).toBeNull();
    expect(derive(baseSet(0, ids, "guest"), c, 5000).playlist).toEqual([]);
    const removed = derive([...baseSet(0, ids), ...baseSet(2500, [])], c, 20_000);
    expect(removed.base).toBeNull();
    expect(removed.playlist.every((p) => p.closedAt <= 3000)).toBe(true);
  });

  test("keepers after the party include played base songs but not unplayed ones", () => {
    const s = derive(baseSet(0, ids), c, 12_500);
    const played = keepers(s.playlist, 12_500).map((x) => x.id);
    expect(played.length).toBeGreaterThan(0);
    expect(played.length).toBeLessThan(s.playlist.length + 1);
    expect(s.playlist.filter((p) => p.startAt <= 12_500).map((p) => p.song.id)).toEqual(played);
  });
});

describe("keepers", () => {
  const entry = (id: string, round: number, skipped = false) => ({
    song: song(id), round, votes: 1, closedAt: 0, startAt: round * 10, endAt: 0, skippers: [], skipped, source: "vote" as const,
  });

  test("keeps play order, drops skipped songs and repeats", () => {
    const list = [entry("a", 0), entry("b", 1, true), entry("c", 2), entry("a", 3), entry("b", 4)];
    expect(keepers(list).map((s) => s.id)).toEqual(["a", "c", "b"]);
  });

  test("only songs that actually started playing", () => {
    const list = [entry("a", 0), entry("c", 2), entry("d", 3)]; // start at 0, 20, 30
    expect(keepers(list, 25).map((s) => s.id)).toEqual(["a", "c"]);
  });
});

describe("protocol", () => {
  test("ticket roundtrip", () => {
    const t = { cfg, peers: [{ id: "abc", relay: "https://relay.example/" }] };
    expect(decodeTicket(encodeTicket(t))).toEqual(t);
    expect(decodeTicket("garbage")).toBeNull();
  });

  test("chunking keeps frames small and lossless", () => {
    const events = Array.from({ length: 500 }, (_, i) => propose(`s${i}`, i));
    const chunks = chunkEvents("sync", events);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThan(32 * 1024);
    expect(chunks.flatMap((c) => decodeWire(c)!.e)).toEqual(events);
  });

  test("validation rejects junk and far-future events", () => {
    expect(validEvent({ ...propose("x", 0), sig: "00" }, 0)).toBe(true);
    expect(validEvent({ ...propose("x", 0), sig: "00", ts: 10 ** 9 }, 0)).toBe(false);
    expect(validEvent({ k: "vote", id: "1", by: "u", ts: 0, sig: "", songId: 5, on: true }, 0)).toBe(false);
    expect(validEvent(null, 0)).toBe(false);
    expect(validEvent({ ...skip("x", 2, "u", 0), sig: "00" }, 0)).toBe(true);
    expect(validEvent({ ...skip("x", 2, "u", 0), sig: "00", round: 1.5 }, 0)).toBe(false);
    expect(validEvent({ k: "end", id: "1", by: "h", ts: 0, sig: "00" }, 0)).toBe(true);
    const base = { k: "base", id: "1", by: "h", ts: 0, sig: "00", set: "s", part: 0, total: 1, name: "n", songs: [song("a")] };
    expect(validEvent(base, 0)).toBe(true);
    expect(validEvent({ ...base, part: 1 }, 0)).toBe(false);
    expect(validEvent({ ...base, songs: Array.from({ length: 41 }, (_, i) => song(`s${i}`)) }, 0)).toBe(false);
  });
});
