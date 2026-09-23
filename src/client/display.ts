import { renderSVG } from "uqr";
import { BubbleField } from "./bubbles";
import { SyncedPlayer } from "./player";
import { Session, escapeHtml, fmtTime, installThumbFallback } from "./session";
import { newSessionConfig, type Ticket } from "../shared/protocol";
import type { PlaylistEntry } from "../shared/types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

installThumbFallback();
const bubbles = new BubbleField($("stage"));
let session: Session;
let player: SyncedPlayer | null = null;
const unplayable = new Set<string>();

/**
 * Pick the session to show: `#<ticket>` in the URL, else the host's current one,
 * else start a fresh session. `/display?new&round=60&votes=3&queue=3&name=Party`
 * forces a new session with custom parameters.
 */
async function resolveTicket(): Promise<{ ticket: Ticket | null; fresh: boolean }> {
  const params = new URLSearchParams(location.search);
  if (!params.has("new")) {
    const t = await Session.findTicket();
    if (t) return { ticket: t, fresh: false };
  }
  const num = (k: string) => (params.has(k) ? Number(params.get(k)) : undefined);
  const cfg = newSessionConfig({
    name: params.get("name") ?? "audia",
    roundMs: (num("round") ?? 90) * 1000,
    maxVotes: num("votes") ?? 3,
    maxQueue: num("queue") ?? 3,
  });
  return { ticket: { cfg, peers: [] }, fresh: true };
}

async function publish() {
  await fetch("/api/session", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticket: session.ticket() }),
  }).catch(() => {});
}

async function renderQr() {
  let base = location.origin;
  if (["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) {
    try {
      const { lan } = await (await fetch("/api/info")).json();
      if (lan?.[0]) base = lan[0];
    } catch {}
  }
  const url = `${base}/#${session.ticket()}`;
  $("qr").innerHTML = renderSVG(url, { ecc: "L", border: 0 });
  $("qr-url").textContent = base.replace(/^https?:\/\//, "");
  $("qr").onclick = () => window.open(url, "_blank");
}

function renderStatus() {
  const el = $("status");
  el.dataset.status = session.status;
  const n = session.neighbors.size;
  el.textContent = session.status === "online" ? `${n} peer${n === 1 ? "" : "s"}` : session.status;
}

const row = (p: PlaylistEntry, right: string) => `
  <li>
    <img src="${escapeHtml(p.song.thumb ?? "")}" data-vid="${escapeHtml(p.song.id)}" alt="" />
    <div class="meta"><div class="t">${escapeHtml(p.song.title)}</div><div class="a">${escapeHtml(p.song.artist)}</div></div>
    ${right}
  </li>`;

let known = new Set<string>();
let lastQueueSig = "";

function renderState() {
  const st = session.state();
  const now = session.now();

  // Songs that entered the playlist since last time fly into the pill.
  const played = new Set(st.playlist.map((p) => `${p.round}:${p.song.id}`));
  const winners = new Set(st.playlist.filter((p) => !known.has(`${p.round}:${p.song.id}`)).map((p) => p.song.id));
  known = played;
  bubbles.update(st.candidates, winners);
  $("empty").hidden = st.candidates.length > 0;

  const upcoming = st.playlist.filter((p) => p.startAt > now);
  const history = st.playlist.filter((p) => p.endAt <= now).reverse().slice(0, 8);
  const sig = JSON.stringify([upcoming.map((p) => p.startAt), history.length]);
  if (sig !== lastQueueSig) {
    lastQueueSig = sig;
    $("next").innerHTML = upcoming.map((p) => row(p, `<span class="when" data-start="${p.startAt}"></span>`)).join("");
    $("played").innerHTML = history.map((p) => row(p, "")).join("");
    $("next-empty").hidden = upcoming.length > 0;
  }
}

function tick() {
  const st = session.state();
  const now = session.now();

  const left = st.round.endsAt - now;
  $("round-label").textContent = st.round.held ? "Queue full" : `Round ${st.round.index + 1}`;
  $("round-time").textContent = st.round.held ? "votes rolling" : left > 0 ? fmtTime(left) : "closing…";
  const frac = st.round.held ? 0 : Math.min(1, Math.max(0, left / session.cfg.roundMs));
  $("ring-fg").style.strokeDashoffset = String(100 - frac * 100);

  for (const el of document.querySelectorAll<HTMLElement>("#next [data-start]")) {
    el.textContent = `in ${fmtTime(Number(el.dataset.start) - now)}`;
  }

  const pill = $("pill");
  const np = st.nowPlaying;
  pill.classList.toggle("idle", !np);
  if (np) {
    const s = np.entry.song;
    const img = $<HTMLImageElement>("pill-thumb");
    if (img.dataset.id !== s.id) {
      img.dataset.id = img.dataset.vid = s.id;
      delete img.dataset.fallback;
      img.style.visibility = "";
      img.src = s.thumb ?? "";
      $("pill-title").textContent = s.title;
      $("pill-artist").textContent = s.artist + (unplayable.has(s.id) ? " · can't be embedded" : "");
    }
    const dur = s.durationS * 1000;
    const pct = `${Math.min(100, (np.positionMs / dur) * 100)}%`;
    $("pill-bar").style.width = pct;
    $("pill-knob").style.left = pct;
    $("pill-pos").textContent = fmtTime(np.positionMs);
    $("pill-dur").textContent = fmtTime(dur);
  } else if ($("pill-thumb").dataset.id) {
    $("pill-thumb").dataset.id = "";
    $<HTMLImageElement>("pill-thumb").removeAttribute("src");
    $("pill-title").textContent = "Nothing playing";
    $("pill-artist").textContent = st.playlist.length ? "Next song starts soon" : "Waiting for the first round to close";
    for (const id of ["pill-bar", "pill-knob"]) $(id).style[id === "pill-bar" ? "width" : "left"] = "0%";
    $("pill-pos").textContent = $("pill-dur").textContent = "0:00";
  }

  player?.sync(np && !unplayable.has(np.entry.song.id) ? { videoId: np.entry.song.id, positionS: np.positionMs / 1000 } : null);
}

// --- controls ---

$("sound").addEventListener("click", async (e) => {
  const btn = e.currentTarget as HTMLButtonElement;
  if (player) {
    player.sync(null);
    player = null;
    $("yt-wrap").hidden = true;
    $("yt-wrap").innerHTML = `<div id="yt"></div>`;
    btn.textContent = "♪ Enable sound";
    btn.classList.remove("on");
    return;
  }
  btn.textContent = "Loading player…";
  $("yt-wrap").hidden = false;
  player = await SyncedPlayer.create($("yt"));
  player.onError = (id) => {
    unplayable.add(id);
    $("pill-thumb").dataset.id = "";
  };
  btn.textContent = "♪ Sound on";
  btn.classList.add("on");
});

$("new-session").addEventListener("click", () => {
  if (confirm("Start a new session? Current votes and playlist stay with the old one.")) {
    location.href = "/display?new";
  }
});

// --- boot ---

const { ticket, fresh } = await resolveTicket();
session = await Session.start(ticket, (s) => {
  session = s;
  renderStatus();
});
$("session-name").textContent = session.cfg.name;
if (fresh) {
  await publish();
  history.replaceState(null, "", "/display");
}
session.subscribe(() => {
  renderStatus();
  renderState();
});
renderStatus();
renderState();
renderQr();
tick();
setInterval(tick, 250);
setInterval(renderState, 1000);
// Refresh the QR with current bootstrap peers now and then.
setInterval(renderQr, 60_000);
