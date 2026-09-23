import type { AppEvent, SessionConfig, Song, WireMessage } from "./types";

/** Keep gossip frames well below the 32 KiB limit configured in the wasm crate. */
const CHUNK_BYTES = 24 * 1024;
/** Reject events stamped further in the future than this (clock skew allowance). */
const MAX_FUTURE_MS = 30_000;

const enc = new TextEncoder();
const dec = new TextDecoder();

export const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const fromHex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));

export function randomId(bytes = 12): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Songs per `base` event; keeps each event around 10 KB, well inside a gossip frame. */
export const BASE_PART_SIZE = 40;
/** Largest base playlist accepted (parts × part size). */
export const MAX_BASE_PARTS = 10;

const songFields = (s: Song) => [s.id, s.title, s.artist, s.album ?? "", s.durationS, s.thumb ?? ""];

/** Canonical bytes an event signature covers: everything except `sig`, fixed key order. */
export function signingBytes(e: AppEvent): Uint8Array {
  const body =
    e.k === "propose"
      ? [e.k, e.id, e.by, e.ts, ...songFields(e.song)]
      : e.k === "vote"
        ? [e.k, e.id, e.by, e.ts, e.songId, e.on]
        : e.k === "skip"
          ? [e.k, e.id, e.by, e.ts, e.songId, e.round]
          : e.k === "base"
            ? [e.k, e.id, e.by, e.ts, e.set, e.part, e.total, e.name, e.songs.map(songFields)]
            : e.k === "base-order"
              ? [e.k, e.id, e.by, e.ts, e.order]
              : [e.k, e.id, e.by, e.ts];
  return enc.encode(JSON.stringify(body));
}

const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function validSong(s: unknown): s is Song {
  const x = s as Song;
  return (
    !!x &&
    str(x.id, 32) && x.id.length > 0 &&
    str(x.title, 300) &&
    str(x.artist, 300) &&
    (x.album === undefined || str(x.album, 300)) &&
    (x.thumb === undefined || (str(x.thumb, 1000) && x.thumb.startsWith("https://"))) &&
    num(x.durationS) && x.durationS > 0 && x.durationS < 60 * 60
  );
}

/** Structural validation of untrusted events. Signature is checked separately. */
export function validEvent(e: unknown, now: number): e is AppEvent {
  const x = e as AppEvent;
  if (!x || !str(x.id, 64) || !str(x.by, 128) || !str(x.sig, 128) || !num(x.ts)) return false;
  if (x.ts > now + MAX_FUTURE_MS) return false;
  if (x.k === "propose") return validSong(x.song);
  if (x.k === "vote") return str(x.songId, 32) && typeof x.on === "boolean";
  if (x.k === "skip") return str(x.songId, 32) && Number.isInteger(x.round) && x.round >= 0;
  if (x.k === "end") return true;
  if (x.k === "base-order") return x.order === "shuffle" || x.order === "ordered";
  if (x.k === "base") {
    return (
      str(x.set, 64) &&
      str(x.name, 200) &&
      Number.isInteger(x.total) && x.total >= 1 && x.total <= MAX_BASE_PARTS &&
      Number.isInteger(x.part) && x.part >= 0 && x.part < x.total &&
      Array.isArray(x.songs) && x.songs.length <= BASE_PART_SIZE && x.songs.every(validSong)
    );
  }
  return false;
}

export function encodeWire(msg: WireMessage): Uint8Array {
  return enc.encode(JSON.stringify(msg));
}

export function decodeWire(bytes: Uint8Array): WireMessage | null {
  try {
    const m = JSON.parse(dec.decode(bytes));
    if ((m?.t === "ev" || m?.t === "sync") && Array.isArray(m.e)) return m;
  } catch {}
  return null;
}

/** Split events into wire messages that each fit in one gossip frame. */
export function chunkEvents(t: WireMessage["t"], events: AppEvent[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  let batch: AppEvent[] = [];
  let size = 0;
  for (const e of events) {
    const n = enc.encode(JSON.stringify(e)).length + 1;
    if (batch.length && size + n > CHUNK_BYTES) {
      out.push(encodeWire({ t, e: batch }));
      batch = [];
      size = 0;
    }
    batch.push(e);
    size += n;
  }
  if (batch.length) out.push(encodeWire({ t, e: batch }));
  return out;
}

/** What a newcomer needs to join: session parameters and some peers to bootstrap from. */
export interface Ticket {
  cfg: SessionConfig;
  peers: { id: string; relay?: string }[];
}

export function encodeTicket(t: Ticket): string {
  const b64 = btoa(String.fromCharCode(...enc.encode(JSON.stringify(t))));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeTicket(s: string): Ticket | null {
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const t = JSON.parse(dec.decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
    if (
      t?.cfg?.v === 1 &&
      typeof t.cfg.topic === "string" &&
      (t.cfg.host === undefined || typeof t.cfg.host === "string") &&
      Array.isArray(t.peers)
    ) return t;
  } catch {}
  return null;
}

export function newSessionConfig(opts: Partial<SessionConfig> = {}): SessionConfig {
  return {
    v: 1,
    name: "audia",
    topic: randomId(32),
    epoch: Date.now(),
    roundMs: 90_000,
    graceMs: 3_000,
    maxVotes: 3,
    maxQueue: 3,
    skipVotes: 5,
    ...opts,
  };
}
