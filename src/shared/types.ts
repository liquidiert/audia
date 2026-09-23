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

export type AppEvent = ProposeEvent | VoteEvent;

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
}

export interface DerivedState {
  round: { index: number; startsAt: number; endsAt: number; held: boolean };
  /** Live tally, highest first. */
  candidates: Candidate[];
  playlist: PlaylistEntry[];
  nowPlaying: { entry: PlaylistEntry; positionMs: number } | null;
}
