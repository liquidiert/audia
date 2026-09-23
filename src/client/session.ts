import init, { AudiaNode, type Channel, verify } from "../wasm/audia_gossip.js";
import { DEFAULT_SKIP_VOTES, derive } from "../shared/state";
import {
  chunkEvents,
  decodeTicket,
  decodeWire,
  encodeTicket,
  encodeWire,
  fromHex,
  newSessionConfig,
  randomId,
  signingBytes,
  toHex,
  validEvent,
  type Ticket,
} from "../shared/protocol";
import type { AppEvent, DerivedState, SessionConfig, Song } from "../shared/types";

const WASM_URL = "/wasm/audia_gossip_bg.wasm";
const KEY_STORAGE = "audia.secret";
const logKey = (topic: string) => `audia.log.${topic}`;

export type Status = "starting" | "connecting" | "online" | "offline";

/** Estimate the offset between this device and the serving host's clock. */
async function clockOffset(): Promise<number> {
  try {
    const t0 = Date.now();
    const { now } = await (await fetch("/api/time")).json();
    const t1 = Date.now();
    return now - (t0 + t1) / 2;
  } catch {
    return 0;
  }
}

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);

/**
 * One peer in a voting session: an iroh-gossip endpoint running in the browser
 * plus the replicated event log it maintains.
 */
export class Session {
  readonly events = new Map<string, AppEvent>();
  readonly neighbors = new Set<string>();
  status: Status = "starting";
  relay: string | undefined;

  private listeners = new Set<() => void>();
  private syncTimer: ReturnType<typeof setTimeout> | undefined;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private channel!: Channel;
  private cached: { version: number; at: number; state: DerivedState } | undefined;
  private version = 0;

  private constructor(
    readonly cfg: SessionConfig,
    private bootstrap: Ticket["peers"],
    private node: AudiaNode,
    private offset: number,
  ) {}

  /** Find the session to join: URL hash first, then the serving host's current session. */
  static async findTicket(): Promise<Ticket | null> {
    const fromHash = decodeTicket(location.hash.slice(1));
    if (fromHash) return fromHash;
    try {
      const res = await fetch("/api/session");
      if (res.ok) return decodeTicket((await res.json()).ticket);
    } catch {}
    return null;
  }

  /**
   * Join (or with `host: true` and a fresh ticket, found) a session. The founding
   * browser's endpoint id is written into the config as host; its key lives in
   * localStorage, so only that browser can end the session later.
   */
  static async start(
    ticket: Ticket | null,
    onStatus?: (s: Session) => void,
    opts: { host?: boolean } = {},
  ): Promise<Session> {
    const [offset] = await Promise.all([clockOffset(), init({ module_or_path: WASM_URL })]);
    const stored = localStorage.getItem(KEY_STORAGE);
    const node = await AudiaNode.spawn(stored ? fromHex(stored) : undefined);
    localStorage.setItem(KEY_STORAGE, toHex(node.secretKey()));

    const cfg = ticket?.cfg ?? newSessionConfig({ epoch: Date.now() + offset });
    if (opts.host && !cfg.host) cfg.host = node.endpointId();
    const s = new Session(cfg, ticket?.peers ?? [], node, offset);
    s.status = "connecting";
    onStatus?.(s);
    s.relay = (await withTimeout(node.online(), 15_000)) ?? node.relayUrl();
    await s.join();
    return s;
  }

  get id() {
    return this.node.endpointId();
  }

  now() {
    return Date.now() + this.offset;
  }

  /** A ticket others can use to join, with ourselves as a bootstrap peer. */
  ticket(): string {
    const me = { id: this.id, relay: this.relay };
    const peers = [me, ...this.bootstrap.filter((p) => p.id !== this.id)].slice(0, 4);
    return encodeTicket({ cfg: this.cfg, peers });
  }

  state(): DerivedState {
    const at = Math.floor(this.now() / 250);
    if (this.cached?.version !== this.version || this.cached.at !== at) {
      this.cached = { version: this.version, at, state: derive(this.events.values(), this.cfg, this.now()) };
    }
    return this.cached.state;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async propose(song: Song) {
    const already = this.state().candidates.some((c) => c.song.id === song.id);
    if (!already) await this.emit({ k: "propose", song });
    await this.vote(song.id, true);
  }

  async vote(songId: string, on: boolean) {
    await this.emit({ k: "vote", songId, on });
  }

  /** Vote to skip whatever is playing right now. */
  async skip() {
    const entry = this.state().nowPlaying?.entry;
    if (!entry || entry.skippers.includes(this.id)) return;
    await this.emit({ k: "skip", songId: entry.song.id, round: entry.round });
  }

  /** Whether this browser founded the session and may end it. */
  get isHost() {
    return this.cfg.host === this.id;
  }

  /** End the session for everyone (host only). */
  async end() {
    if (!this.isHost) throw new Error("Only the display that started this session can end it");
    await this.emit({ k: "end" });
  }

  get skipThreshold() {
    return this.cfg.skipVotes ?? DEFAULT_SKIP_VOTES;
  }

  private async join() {
    this.restore();
    const peers = this.addPeers(this.bootstrap);
    this.channel = await this.node.join(fromHex(this.cfg.topic), peers, (ev: any) => this.onGossip(ev));
    this.status = peers.length ? "connecting" : "online";
    this.notify();
    this.heartbeat();
    setInterval(() => this.heartbeat(), 15_000);
    setInterval(() => this.rejoin(), 5_000);
  }

  /** Register bootstrap peers' relay addresses; returns their ids (minus ourselves). */
  private addPeers(peers: Ticket["peers"]): string[] {
    const ids: string[] = [];
    for (const p of peers) {
      if (p.id === this.id) continue;
      try {
        this.node.addPeer(p.id, p.relay);
        ids.push(p.id);
      } catch (e) {
        console.warn("bad bootstrap peer", p, e);
      }
    }
    return ids;
  }

  /**
   * While we have no neighbors, keep asking the host for currently live peers and
   * dial them. Bootstrap peers from a ticket may be long gone (phones sleep).
   */
  private async rejoin() {
    if (this.neighbors.size > 0) return;
    let peers = this.bootstrap;
    try {
      const res = await fetch("/api/session");
      const t = res.ok ? decodeTicket((await res.json()).ticket) : null;
      if (t?.cfg.topic === this.cfg.topic) peers = t.peers;
    } catch {}
    const ids = this.addPeers(peers);
    if (ids.length) await this.channel.joinPeers(ids).catch(console.warn);
  }

  private onGossip(ev: { type: string; content?: Uint8Array; peer?: string; error?: string }) {
    switch (ev.type) {
      case "received": {
        const msg = decodeWire(ev.content!);
        if (msg) this.ingest(msg.e);
        break;
      }
      case "neighborUp":
        this.neighbors.add(ev.peer!);
        this.status = "online";
        this.scheduleSync();
        this.notify();
        break;
      case "neighborDown":
        this.neighbors.delete(ev.peer!);
        this.notify();
        break;
      case "lagged":
        // We missed messages; a full exchange with neighbors fills the gap.
        this.scheduleSync();
        break;
      case "closed":
        console.error("gossip closed", ev.error);
        this.status = "offline";
        this.notify();
        break;
    }
  }

  /** Send our full log to direct neighbors; they do the same, so both sides converge. */
  private scheduleSync() {
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(async () => {
      for (const chunk of chunkEvents("sync", [...this.events.values()])) {
        await this.channel.broadcastNeighbors(chunk).catch(console.warn);
      }
    }, 300 + Math.random() * 400);
  }

  private async emit(body: Pick<AppEvent, "k"> & Record<string, unknown>) {
    const e = { ...body, id: randomId(), by: this.id, ts: Math.round(this.now()), sig: "" } as AppEvent;
    e.sig = toHex(this.node.sign(signingBytes(e)));
    this.ingest([e]);
    await this.channel.broadcast(encodeWire({ t: "ev", e: [e] }));
  }

  private ingest(events: unknown[]) {
    const now = this.now();
    let added = 0;
    for (const e of events) {
      if (!validEvent(e, now) || this.events.has(e.id)) continue;
      if (!verify(e.by, signingBytes(e), fromHex(e.sig))) continue;
      this.events.set(e.id, e);
      added++;
    }
    if (added) {
      this.version++;
      this.persist();
      this.notify();
    }
  }

  private notify() {
    for (const fn of this.listeners) fn();
  }

  /** Keep the log across reloads (phones drop tabs a lot). */
  private persist() {
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      try {
        localStorage.setItem(logKey(this.cfg.topic), JSON.stringify([...this.events.values()]));
      } catch {}
    }, 1000);
  }

  private restore() {
    try {
      const saved = JSON.parse(localStorage.getItem(logKey(this.cfg.topic)) ?? "[]");
      if (Array.isArray(saved)) this.ingest(saved);
    } catch {}
  }

  /** Tell the serving host we're alive so it can hand us out as a bootstrap peer. */
  private heartbeat() {
    fetch("/api/session/peers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic: this.cfg.topic, id: this.id, relay: this.relay }),
    }).catch(() => {});
  }
}

/** Fallback artwork served by YouTube itself, for when the Music CDN refuses (it rate-limits). */
export const fallbackThumb = (videoId: string) => `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/mqdefault.jpg`;

/** `<img data-vid>` that fail to load retry once with the fallback, then hide. */
export function installThumbFallback() {
  document.addEventListener(
    "error",
    (e) => {
      const img = e.target;
      if (!(img instanceof HTMLImageElement) || !img.dataset.vid) return;
      if (img.dataset.fallback) img.style.visibility = "hidden";
      else {
        img.dataset.fallback = "1";
        img.src = fallbackThumb(img.dataset.vid);
      }
    },
    true,
  );
}

export function fmtTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
