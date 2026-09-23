import { networkInterfaces } from "node:os";
import YTMusic from "ytmusic-api";
import vote from "./client/vote.html";
import display from "./client/display.html";
import { decodeTicket, encodeTicket, type Ticket } from "./shared/protocol";
import type { Song } from "./shared/types";

const PORT = Number(process.env.PORT ?? 3000);
const SESSION_FILE = process.env.AUDIA_SESSION_FILE ?? ".audia-session.json";
const PEER_TTL_MS = 45_000;

// --- YouTube Music search (unofficial InnerTube API; browsers can't call it due to CORS) ---

const yt = new YTMusic();
const ytReady = yt.initialize().catch((e) => console.error("ytmusic init failed:", e));
const searchCache = new Map<string, { at: number; songs: Song[] }>();

async function search(q: string): Promise<Song[]> {
  const key = q.toLowerCase();
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.songs;
  await ytReady;
  const songs = (await yt.searchSongs(q))
    .filter((s) => s.videoId && s.duration)
    .slice(0, 20)
    .map((s) => ({
      id: s.videoId,
      title: s.name,
      artist: s.artist?.name ?? "Unknown",
      album: s.album?.name || undefined,
      durationS: s.duration!,
      thumb: [...s.thumbnails].sort((a, b) => b.width - a.width)[0]?.url.replace(/=w\d+-h\d+/, "=w400-h400"),
    }));
  if (searchCache.size > 500) searchCache.clear();
  searchCache.set(key, { at: Date.now(), songs });
  return songs;
}

// --- Session directory: lets phones join without a ticket in the URL ---

let session: Ticket | null = null;
const peers = new Map<string, { relay?: string; seen: number }>();

try {
  session = decodeTicket(await Bun.file(SESSION_FILE).text());
  if (session) console.log(`restored session "${session.cfg.name}" (${session.cfg.topic.slice(0, 8)}…)`);
} catch {}

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
    "/": vote,
    "/display": display,

    "/wasm/audia_gossip_bg.wasm": () =>
      new Response(Bun.file(new URL("./wasm/audia_gossip_bg.wasm", import.meta.url).pathname), {
        headers: { "content-type": "application/wasm", "cache-control": "public, max-age=3600" },
      }),

    "/api/time": () => Response.json({ now: Date.now() }),

    "/api/info": () => Response.json({ lan: lanUrls() }),

    "/api/search": async (req) => {
      const q = new URL(req.url).searchParams.get("q")?.trim().slice(0, 200);
      if (!q) return Response.json([]);
      try {
        return Response.json(await search(q));
      } catch (e) {
        console.error("search failed:", e);
        return Response.json({ error: "search failed" }, { status: 502 });
      }
    },

    "/api/session": {
      GET: () => {
        const ticket = currentTicket();
        return ticket ? Response.json({ ticket }) : Response.json({ error: "no session" }, { status: 404 });
      },
      PUT: async (req) => {
        const t = decodeTicket(((await req.json()) as { ticket?: string }).ticket ?? "");
        if (!t) return Response.json({ error: "bad ticket" }, { status: 400 });
        if (t.cfg.topic !== session?.cfg.topic) peers.clear();
        session = t;
        await Bun.write(SESSION_FILE, encodeTicket(t));
        return Response.json({ ok: true });
      },
    },

    "/api/session/peers": {
      POST: async (req) => {
        const { topic, id, relay } = (await req.json()) as { topic?: string; id?: string; relay?: string };
        if (!session || topic !== session.cfg.topic || typeof id !== "string" || id.length > 128) {
          return Response.json({ ok: false });
        }
        peers.set(id, { relay: typeof relay === "string" ? relay : undefined, seen: Date.now() });
        return Response.json({ ok: true });
      },
    },
  },
});

console.log(`audia running
  display: ${server.url}display
  vote:    ${server.url}
  LAN:     ${lanUrls().join(", ") || "-"}`);
