import { describe, expect, test } from "bun:test";
import { derive, votesOf } from "./state";
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
  });
});
