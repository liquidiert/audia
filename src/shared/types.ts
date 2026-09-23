/** A song as discovered via YouTube Music search. `id` is the YouTube videoId. */
export interface Song {
  id: string;
  title: string;
  artist: string;
  album?: string;
  durationS: number;
  thumb?: string;
}

/** Session-wide parameters. Shared via the ticket; identical on every peer. */
export interface SessionConfig {
  v: 1;
  name: string;
  /** 32-byte gossip topic, hex encoded. */
  topic: string;
  /** Round 0 starts here (unix ms). */
  epoch: number;
  /** Length of one voting round. */
  roundMs: number;
  /** Wait this long after a round ends before finalising, so late gossip lands. */
  graceMs: number;
  /** Only a voter's N most recent votes count. */
  maxVotes: number;
  /** A round only closes if fewer than this many songs are queued (not yet finished). */
  maxQueue: number;
  /** Distinct skip votes that end the playing song early. Optional for older tickets. */
  skipVotes?: number;
  /** Endpoint id of the display that started the session; only it can end the session. */
  host?: string;
}

interface EventBase {
  /** Unique event id. */
  id: string;
  /** Author's iroh endpoint id. */
  by: string;
  /** Author's (clock-corrected) unix ms timestamp. */
  ts: number;
  /** ed25519 signature (hex) by `by` over `signingBytes(event)`. */
  sig: string;
}

export interface ProposeEvent extends EventBase {
  k: "propose";
  song: Song;
}

export interface VoteEvent extends EventBase {
  k: "vote";
  songId: string;
  on: boolean;
}

/** Vote to skip a playlist entry (identified by round + song). Only counts while it plays. */
export interface SkipEvent extends EventBase {
  k: "skip";
  songId: string;
  round: number;
}

/**
 * One part of the host's base playlist (fallback songs when nobody votes).
 * Big lists are split into parts that share `set`; a set counts once all
 * `total` parts are there. A set with no songs removes the base playlist.
 */
export interface BaseEvent extends EventBase {
  k: "base";
  set: string;
  part: number;
  total: number;
  name: string;
  songs: Song[];
}

export type BaseOrder = "shuffle" | "ordered";

/** Host setting: how songs are taken from the base playlist. Latest one wins. */
export interface BaseOrderEvent extends EventBase {
  k: "base-order";
  order: BaseOrder;
}

/** The host ends the session: nothing after `ts` counts, the music stops. */
export interface EndEvent extends EventBase {
  k: "end";
}

export type AppEvent = ProposeEvent | VoteEvent | SkipEvent | BaseEvent | BaseOrderEvent | EndEvent;

/** Messages on the gossip wire (JSON, utf-8). */
export type WireMessage =
  /** Freshly created events. */
  | { t: "ev"; e: AppEvent[] }
  /** Part of a full-log sync sent to neighbors when they come up. */
  | { t: "sync"; e: AppEvent[] };

export interface Candidate {
  song: Song;
  votes: number;
  voters: string[];
  proposedAt: number;
  proposedBy: string;
}

export interface PlaylistEntry {
  song: Song;
  round: number;
  votes: number;
  closedAt: number;
  startAt: number;
  endAt: number;
  /** Voters who asked to skip this entry while it was playing. */
  skippers: string[];
  /** Ended early because enough skip votes came in. */
  skipped: boolean;
  /** Voted in by the crowd, or picked from the base playlist because nobody voted. */
  source: "vote" | "base";
}

export interface DerivedState {
  round: { index: number; startsAt: number; endsAt: number; held: boolean };
  /** Live tally, highest first. */
  candidates: Candidate[];
  playlist: PlaylistEntry[];
  nowPlaying: { entry: PlaylistEntry; positionMs: number } | null;
  /** When the host ended the session, if it has. */
  endedAt: number | null;
  /** The base playlist currently in effect, if any. */
  base: { name: string; songs: number } | null;
  /** How base songs are picked (applies once a base playlist is set). */
  baseOrder: BaseOrder;
}
