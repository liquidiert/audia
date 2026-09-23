import init, { AudiaNode, type Channel, verify } from "../wasm/audia_gossip.js";
import { DEFAULT_SKIP_VOTES, derive } from "../shared/state";
import {
  BASE_PART_SIZE,
  MAX_BASE_PARTS,
  chunkEvents,
  decodeTicket,
  decodeWire,
  encodeTicket,
  encodeWire,
  fromHex,
  heartbeatMessage,
  newSessionConfig,
  randomId,
  signingBytes,
  toHex,
  validEvent,
  type Ticket,
} from "../shared/protocol";
import type { AppEvent, BaseOrder, DerivedState, SessionConfig, Song } from "../shared/types";

const WASM_URL = "/wasm/audia_gossip_bg.wasm";
/**
 * Flood limits for the replicated log. Honest guests produce a handful of events a
 * minute; these stop one misbehaving peer from bloating memory or stalling every
 * device's reducer. (Peers may disagree about an abuser's excess events, never an
 * honest guest's.) The host is exempt: its base playlist alone can be 10 events.
 */
const MAX_EVENTS_PER_AUTHOR = 600;
const MAX_EVENTS_PER_AUTHOR_PER_MINUTE = 60;
const MAX_EVENTS_TOTAL = 20_000;
/** Live broadcasts must be fresh; older events only arrive through the catch-up sync. */
const LIVE_EVENT_MAX_AGE_MS = 2 * 60_000;
/**
 * Where each role keeps its iroh secret key. The display keeps the original key name,
 * because its endpoint id is the session's host (only it can end the session).
 */
const KEY_STORAGE: Record<"phone" | "display", string> = { display: "audia.secret", phone: "audia.secret.phone" };

/**
 * One stored identity per role, and only one tab may use it at a time: two endpoints
 * with the same key (say, the display and a voting page in the same browser) each
 * skip "themselves" when bootstrapping and confuse the relay. A tab that finds the
 * identity in use gets a throwaway key instead. The lock is held until the tab closes.
 */
async function claimIdentity(role: "phone" | "display"): Promise<{ key?: Uint8Array; persist: boolean }> {
  const name = KEY_STORAGE[role];
  const locks = (navigator as Navigator & { locks?: LockManager }).locks; // missing outside secure contexts
  if (locks) {
    const claimed = await new Promise<boolean>((resolve) => {
      locks
        .request(name, { ifAvailable: true }, (lock) => {
          resolve(!!lock);
          return lock ? new Promise<void>(() => {}) : undefined;
        })
        .catch(() => resolve(true));
    });
    if (!claimed) return { persist: false };
  }
  const stored = localStorage.getItem(name);
  return { key: stored ? fromHex(stored) : undefined, persist: true };
}
const logKey = (topic: string) => `audia.log.${topic}`;

export type Status = "starting" | "connecting" | "online" | "offline";

/**
 * Phones reach the session through cookie-gated endpoints (they joined via the QR
 * code); the display through Basic-auth ones, which challenge for the password
 * instead of refusing, so the browser always sends its credentials.
 */
export type Role = "phone" | "display";
const ENDPOINTS: Record<Role, { session: string; peers: string }> = {
  phone: { session: "/api/session", peers: "/api/session/peers" },
  display: { session: "/api/display/session", peers: "/api/display/peers" },
};

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
  private reportTimer: ReturnType<typeof setTimeout> | undefined;
  private lastError: string | undefined;
  private version = 0;

  private constructor(
    readonly cfg: SessionConfig,
    private bootstrap: Ticket["peers"],
    private node: AudiaNode,
    private offset: number,
    private role: Role,
  ) {}

  /**
   * Find the serving host's current session. (Tickets in the URL are deliberately not
   * accepted: a crafted link could otherwise point a device at an attacker's session.)
   * Returns null only when there is no session. For the display, any other failure
   * throws: silently founding a new session would strand every phone on the old one.
   */
  static async findTicket(role: Role = "phone"): Promise<Ticket | null> {
    let res: Response;
    try {
      res = await fetch(ENDPOINTS[role].session);
    } catch (e) {
      if (role === "display") throw new Error(`Can't reach the server: ${(e as Error).message}`);
      return null;
    }
    if (res.ok) return decodeTicket((await res.json()).ticket);
    if (res.status === 404 || role === "phone") return null;
    throw new Error(`Can't load the current session (HTTP ${res.status})`);
  }

  /**
   * Join (or with `host: true` and a fresh ticket, found) a session. The founding
   * browser's endpoint id is written into the config as host; its key lives in
   * localStorage, so only that browser can end the session later.
   */
  static async start(
    ticket: Ticket | null,
    onStatus?: (s: Session) => void,
    opts: { host?: boolean; role?: Role } = {},
  ): Promise<Session> {
    const [offset] = await Promise.all([clockOffset(), init({ module_or_path: WASM_URL })]);
    const role = opts.role ?? "phone";
    const identity = await claimIdentity(role);
    const node = await AudiaNode.spawn(identity.key);
    if (identity.persist) localStorage.setItem(KEY_STORAGE[role], toHex(node.secretKey()));

    const cfg = ticket?.cfg ?? newSessionConfig({ epoch: Date.now() + offset });
    if (opts.host && !cfg.host) cfg.host = node.endpointId();
    const s = new Session(cfg, ticket?.peers ?? [], node, offset, role);
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

  /**
   * Set (or with no songs, remove) the base playlist that fills silence when nobody
   * votes. Host only; sent in parts because a whole list won't fit in one gossip frame.
   */
  async setBase(songs: Song[], name: string) {
    if (!this.isHost) throw new Error("Only the display that started this session can change the base playlist");
    const set = randomId();
    const total = Math.max(1, Math.ceil(songs.length / BASE_PART_SIZE));
    if (total > MAX_BASE_PARTS) throw new Error(`Base playlists can have at most ${BASE_PART_SIZE * MAX_BASE_PARTS} songs`);
    for (let part = 0; part < total; part++) {
      const chunk = songs.slice(part * BASE_PART_SIZE, (part + 1) * BASE_PART_SIZE);
      await this.emit({ k: "base", set, part, total, name: name.slice(0, 200), songs: chunk });
    }
  }

  /** Shuffle or play the base playlist in its own order (host only). */
  async setBaseOrder(order: BaseOrder) {
    if (!this.isHost) throw new Error("Only the display that started this session can change the base playlist");
    await this.emit({ k: "base-order", order });
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
    // Tabs that come back to the foreground report right away (hidden tabs are throttled).
    document.addEventListener("visibilitychange", () => this.reportSoon());
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
      const res = await fetch(ENDPOINTS[this.role].session);
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
        if (msg) this.ingest(msg.e, msg.t === "ev");
        break;
      }
      case "neighborUp":
        this.neighbors.add(ev.peer!);
        this.status = "online";
        this.scheduleSync();
        this.notify();
        this.reportSoon();
        break;
      case "neighborDown":
        this.neighbors.delete(ev.peer!);
        this.notify();
        this.reportSoon();
        break;
      case "lagged":
        // We missed messages; a full exchange with neighbors fills the gap.
        this.scheduleSync();
        break;
      case "closed":
        console.error("gossip closed", ev.error);
        this.lastError = `gossip closed: ${ev.error ?? "no error"}`.slice(0, 300);
        this.status = "offline";
        this.notify();
        this.reportSoon();
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

  private perAuthor = new Map<string, number[]>();

  /** Room for another event from this author (host exempt), counting its timestamps. */
  private withinLimits(e: AppEvent): boolean {
    if (e.by === this.cfg.host) return true;
    if (this.events.size >= MAX_EVENTS_TOTAL) return false;
    const times = this.perAuthor.get(e.by) ?? [];
    if (times.length >= MAX_EVENTS_PER_AUTHOR) return false;
    const recent = times.filter((t) => Math.abs(t - e.ts) < 60_000).length;
    if (recent >= MAX_EVENTS_PER_AUTHOR_PER_MINUTE) return false;
    times.push(e.ts);
    this.perAuthor.set(e.by, times);
    return true;
  }

  private ingest(events: unknown[], live = false) {
    const now = this.now();
    let added = 0;
    for (const e of events) {
      if (!validEvent(e, now) || this.events.has(e.id)) continue;
      if (live && now - e.ts > LIVE_EVENT_MAX_AGE_MS) continue;
      if (!verify(e.by, signingBytes(e), fromHex(e.sig))) continue;
      if (!this.withinLimits(e)) continue;
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
    const ts = Math.round(this.now());
    fetch(ENDPOINTS[this.role].peers, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        topic: this.cfg.topic,
        id: this.id,
        relay: this.relay,
        // Signed, so nobody can register our id with a different relay.
        ts,
        sig: toHex(this.node.sign(new TextEncoder().encode(heartbeatMessage(this.cfg.topic, this.id, this.relay ?? "", ts)))),
        // Diagnostics for the server log: how this peer sees the swarm.
        role: this.role,
        status: this.status,
        neighbors: this.neighbors.size,
        visible: document.visibilityState === "visible",
        error: this.lastError,
      }),
    }).catch(() => {});
  }

  /** Report connection changes promptly rather than waiting for the next 15s heartbeat. */
  private reportSoon() {
    clearTimeout(this.reportTimer);
    this.reportTimer = setTimeout(() => this.heartbeat(), 1000);
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
