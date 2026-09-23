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

describe("keepers", () => {
  test("keeps play order, drops skipped songs and repeats", () => {
    const entry = (id: string, round: number, skipped = false) => ({
      song: song(id), round, votes: 1, closedAt: 0, startAt: 0, endAt: 0, skippers: [], skipped,
    });
    const list = [entry("a", 0), entry("b", 1, true), entry("c", 2), entry("a", 3), entry("b", 4)];
    expect(keepers(list).map((s) => s.id)).toEqual(["a", "c", "b"]);
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
  });
});
