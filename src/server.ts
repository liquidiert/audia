import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import YTMusic from "ytmusic-api";
import vote from "./client/vote.html";
import display from "./client/display.html";
import { basicAuth, clientAddress, decodePasswordHash } from "./auth";
import {
  gatePage,
  hasJoined,
  isSecure,
  joinCookie,
  newJoinToken,
  parseSession,
  serializeSession,
  tokenMatches,
} from "./join";
import { BASE_PART_SIZE, MAX_BASE_PARTS, decodeTicket, encodeTicket, type Ticket } from "./shared/protocol";
import type { Song } from "./shared/types";

const PORT = Number(process.env.PORT ?? 3000);
const SESSION_FILE = process.env.AUDIA_SESSION_FILE ?? ".audia-session.json";
const PEER_TTL_MS = 45_000;
/** Public OAuth client id for saving playlists to YouTube (optional; not a secret). */
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || null;

// --- Basic auth for the display and the endpoints only it uses ---

const auth = basicAuth({
  user: process.env.DISPLAY_USER || "audia",
  passwordHash: decodePasswordHash(process.env.DISPLAY_PASSWORD_HASH),
});
if (!auth.enabled) {
  console.warn("⚠ DISPLAY_PASSWORD_HASH is not set: /display is open to everyone. Run `bun run hash-password`.");
}

type Handler = (req: Request, server: Bun.Server<undefined>) => Response | Promise<Response>;
const guarded =
  (handler: Handler): Handler =>
  async (req, server) =>
    (await auth.check(req, clientAddress(req, server.requestIP(req)?.address))) ?? handler(req, server);

/**
 * Bun can't put a check in front of an HTML import route, so the bundled pages live
 * at unguessable paths and `/display` and `/` proxy to them after checking access.
 */
const DISPLAY_BUNDLE_PATH = `/_display-${randomUUID()}`;
const VOTE_BUNDLE_PATH = `/_vote-${randomUUID()}`;

async function serveBundle(path: string, req: Request, server: Bun.Server<undefined>): Promise<Response> {
  const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    headers: { accept: req.headers.get("accept") ?? "text/html" },
  });
  return new Response(res.body, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "text/html", "cache-control": "no-store" },
  });
}

// --- YouTube Music search (unofficial InnerTube API; browsers can't call it due to CORS) ---

const yt = new YTMusic();
const ytReady = yt.initialize().catch((e) => console.error("ytmusic init failed:", e));
const searchCache = new Map<string, { at: number; songs: Song[] }>();

type YtTrack = {
  videoId: string;
  name: string;
  artist?: { name: string } | null;
  album?: { name: string } | null;
  duration: number | null;
  thumbnails: { url: string; width: number }[];
};

/** Map a ytmusic-api result to our Song, or null if it can't be played in a session. */
function toSong(s: YtTrack): Song | null {
  // Events reject songs without a duration or longer than an hour (mixes, livestreams).
  if (!s.videoId || !s.duration || s.duration >= 3600) return null;
  const thumb = [...s.thumbnails].sort((a, b) => b.width - a.width)[0]?.url.replace(/=w\d+-h\d+/, "=w400-h400");
  return {
    id: s.videoId,
    title: s.name.slice(0, 300),
    artist: (s.artist?.name ?? "Unknown").slice(0, 300),
    album: s.album?.name?.slice(0, 300) || undefined,
    durationS: s.duration,
    thumb: thumb?.startsWith("https://") && thumb.length <= 1000 ? thumb : undefined,
  };
}

async function search(q: string): Promise<Song[]> {
  const key = q.toLowerCase();
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.songs;
  await ytReady;
  const songs = (await yt.searchSongs(q))
    .map(toSong)
    .filter((s): s is Song => s !== null)
    .slice(0, 20);
  if (searchCache.size > 500) searchCache.clear();
  searchCache.set(key, { at: Date.now(), songs });
  return songs;
}

/** Largest base playlist; matches BASE_PART_SIZE × MAX_BASE_PARTS in the protocol. */
const MAX_BASE_SONGS = BASE_PART_SIZE * MAX_BASE_PARTS;

/** Accepts a playlist id or any YouTube / YouTube Music URL with `list=`. */
function playlistIdFrom(input: string): string | null {
  let id = input.trim();
  try {
    id = new URL(id).searchParams.get("list") ?? "";
  } catch {}
  id = id.replace(/^VL/, "");
  return /^[A-Za-z0-9_-]{10,80}$/.test(id) ? id : null;
}

async function loadPlaylist(id: string): Promise<{ name: string; songs: Song[] }> {
  await ytReady;
  const [meta, videos] = await Promise.all([yt.getPlaylist(id).catch(() => null), yt.getPlaylistVideos(id)]);
  const seen = new Set<string>();
  const songs = videos
    .map(toSong)
    .filter((s): s is Song => s !== null && !seen.has(s.id) && !!seen.add(s.id))
    .slice(0, MAX_BASE_SONGS);
  return { name: (meta?.name || "Base playlist").slice(0, 200), songs };
}

// --- Session directory: lets phones that scanned the QR code find the session ---

const label = (t: Ticket) => `"${t.cfg.name}" (${t.cfg.topic.slice(0, 8)}…)`;

let session: Ticket | null = null;
/** Secret in the display's QR code; phones need it (as a cookie) to reach the voting page. */
let joinToken: string | null = null;
const peers = new Map<string, { relay?: string; seen: number }>();

try {
  const stored = parseSession(await Bun.file(SESSION_FILE).text());
  if (stored) {
    ({ ticket: session, joinToken } = stored);
    console.log(`restored session ${label(session)}`);
  }
} catch {}

const saveSession = () =>
  session && joinToken ? Bun.write(SESSION_FILE, serializeSession({ ticket: session, joinToken })) : Promise.resolve(0);

/**
 * Phone-side endpoints: open to phones that joined via the current QR code, and to
 * the display (Basic auth). Without a display password nothing is protected, so
 * local development keeps working without setup.
 */
const members =
  (handler: Handler): Handler =>
  async (req, server) => {
    if (!auth.enabled || hasJoined(req, joinToken)) return handler(req, server);
    if (req.headers.has("authorization")) return guarded(handler)(req, server);
    return Response.json({ error: "Scan the QR code on the display to join." }, { status: 403 });
  };

/** Heartbeat from a peer (phone or display): remember it as a bootstrap candidate. */
const registerPeer: Handler = async (req) => {
  const { topic, id, relay } = (await req.json()) as { topic?: string; id?: string; relay?: string };
  if (!session || topic !== session.cfg.topic || typeof id !== "string" || id.length > 128) {
    return Response.json({ ok: false });
  }
  peers.set(id, { relay: typeof relay === "string" ? relay : undefined, seen: Date.now() });
  return Response.json({ ok: true });
};

let joinsThisSession = 0;

const notJoined = () =>
  gatePage("Scan to join", "Voting is only open to guests who scan the QR code on the big screen.");

function currentTicket(): string | null {
  if (!session) return null;
  const now = Date.now();
  const live = [...peers.entries()]
    .filter(([, p]) => now - p.seen < PEER_TTL_MS)
    .sort((a, b) => b[1].seen - a[1].seen)
    .map(([id, p]) => ({ id, relay: p.relay }));
  const merged = [...live, ...session.peers.filter((p) => !peers.has(p.id))].slice(0, 6);
  return encodeTicket({ cfg: session.cfg, peers: merged });
}

function lanUrls(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => `http://${i!.address}:${PORT}`);
}

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  development: process.env.NODE_ENV !== "production",
  routes: {
    [VOTE_BUNDLE_PATH]: vote,
    [DISPLAY_BUNDLE_PATH]: display,
    "/": (req, server) =>
      !auth.enabled || hasJoined(req, joinToken) ? serveBundle(VOTE_BUNDLE_PATH, req, server) : notJoined(),
    "/display": guarded((req, server) => serveBundle(DISPLAY_BUNDLE_PATH, req, server)),

    /** Target of the display's QR code: remember the session's token, then open the voting page. */
    "/join/:token": (req: Request & { params: Record<string, string | undefined> }) => {
      if (!session || !tokenMatches(req.params.token ?? "", joinToken)) {
        console.log("join rejected: expired or unknown QR code");
        return gatePage("This code has expired", "That QR code belongs to a session that has ended. Scan the one on the big screen.");
      }
      console.log(`phone joined ${label(session)} via QR code (${++joinsThisSession} this session)`);
      return new Response(null, {
        status: 302,
        headers: { location: "/", "set-cookie": joinCookie(joinToken!, isSecure(req)), "cache-control": "no-store" },
      });
    },

    "/wasm/audia_gossip_bg.wasm": () =>
      new Response(Bun.file(new URL("./wasm/audia_gossip_bg.wasm", import.meta.url).pathname), {
        headers: { "content-type": "application/wasm", "cache-control": "public, max-age=3600" },
      }),

    "/api/time": () => Response.json({ now: Date.now() }),

    "/api/info": guarded(() => Response.json({ lan: lanUrls(), googleClientId: GOOGLE_CLIENT_ID })),

    "/api/search": members(async (req) => {
      const q = new URL(req.url).searchParams.get("q")?.trim().slice(0, 200);
      if (!q) return Response.json([]);
      try {
        return Response.json(await search(q));
      } catch (e) {
        console.error("search failed:", e);
        return Response.json({ error: "search failed" }, { status: 502 });
      }
    }),

    /** Read a YouTube Music playlist to use as the session's base playlist (display only). */
    "/api/playlist": guarded(async (req) => {
      const id = playlistIdFrom(new URL(req.url).searchParams.get("list") ?? "");
      if (!id) return Response.json({ error: "That doesn't look like a playlist link." }, { status: 400 });
      try {
        const list = await loadPlaylist(id);
        if (!list.songs.length) return Response.json({ error: "No playable songs in that playlist." }, { status: 422 });
        return Response.json(list);
      } catch (e) {
        console.error("playlist load failed:", id, e);
        return Response.json(
          { error: "Couldn't read that playlist. Use a public or unlisted playlist you made (not a chart or radio mix)." },
          { status: 502 },
        );
      }
    }),

    "/api/session": {
      GET: members(() => {
        const ticket = currentTicket();
        return ticket ? Response.json({ ticket }) : Response.json({ error: "no session" }, { status: 404 });
      }),
      PUT: guarded(async (req) => {
        const t = decodeTicket(((await req.json()) as { ticket?: string }).ticket ?? "");
        if (!t) return Response.json({ error: "bad ticket" }, { status: 400 });
        // A new session gets a new join token, which locks out phones from the old one.
        if (t.cfg.topic !== session?.cfg.topic) {
          peers.clear();
          joinToken = newJoinToken();
          joinsThisSession = 0;
          console.log(session ? `session ${label(session)} replaced by ${label(t)}` : `session ${label(t)} started`);
        }
        session = t;
        joinToken ??= newJoinToken();
        await saveSession();
        return Response.json({ ok: true });
      }),
      /** Session ended: stop handing it out, and void its QR code. */
      DELETE: guarded(async () => {
        if (session) console.log(`session ${label(session)} ended`);
        session = null;
        joinToken = null;
        peers.clear();
        await unlink(SESSION_FILE).catch(() => {});
        return Response.json({ ok: true });
      }),
    },

    /**
     * The display's view of the session: the ticket and its QR code target. Basic auth
     * challenges when credentials are missing, so the browser always sends them; a
     * refusal here must never look like "no session" (the display would found a new one).
     */
    "/api/display/session": guarded(() => {
      const ticket = currentTicket();
      return ticket && joinToken
        ? Response.json({ ticket, path: `/join/${joinToken}` })
        : Response.json({ error: "no session" }, { status: 404 });
    }),
    "/api/display/peers": { POST: guarded(registerPeer) },

    "/api/session/peers": { POST: members(registerPeer) },
  },
});

console.log(`audia running
  display: ${server.url}display
  phones:  scan the QR code on the display (${server.url}join/<token>)
  LAN:     ${lanUrls().join(", ") || "-"}`);
