import { renderSVG } from "uqr";
import { BubbleField } from "./bubbles";
import { SyncedPlayer } from "./player";
import { Session, escapeHtml, fmtTime, installThumbFallback } from "./session";
import {
  addVideos,
  createPlaylist,
  explain,
  loadGoogleIdentity,
  playlistUrl,
  requestToken,
  watchVideosUrl,
  WATCH_VIDEOS_LIMIT,
  type Privacy,
} from "./youtube";
import { keepers } from "../shared/state";
import { newSessionConfig, type Ticket } from "../shared/protocol";
import type { PlaylistEntry, Song } from "../shared/types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

installThumbFallback();
const bubbles = new BubbleField($("stage"));
let session: Session;
let player: SyncedPlayer | null = null;
const unplayable = new Set<string>();
const info: Promise<{ lan?: string[]; googleClientId?: string | null }> = fetch("/api/info")
  .then((r) => r.json())
  .catch(() => ({}));

/**
 * Pick the session to show: `#<ticket>` in the URL, else the host's current one,
 * else start a fresh session. `/display?new&round=60&votes=3&queue=3&skip=5&name=Party`
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
    skipVotes: num("skip") ?? 5,
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
    const { lan } = await info;
    if (lan?.[0]) base = lan[0];
  }
  // The QR code carries the session's join token; phones without it can't open the voting page.
  let path: string | undefined;
  try {
    const res = await fetch("/api/session/join");
    if (res.ok) path = (await res.json()).path;
  } catch {}
  if (!path) {
    $("qr").innerHTML = "";
    $("qr-url").textContent = "No active session";
    return;
  }
  const url = `${base}${path}`;
  // Short URL: medium error correction still gives big, easy-to-scan modules.
  $("qr").innerHTML = renderSVG(url, { ecc: "M", border: 0 });
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

  const ended = st.endedAt !== null;
  document.body.classList.toggle("session-ended", ended);
  $("ended").hidden = !ended;
  $<HTMLButtonElement>("end-session").hidden = ended;
  if (ended) {
    const n = keepers(st.playlist, now).length;
    $("ended-summary").textContent = n
      ? `${n} song${n === 1 ? "" : "s"} played tonight. Thanks for voting!`
      : "No songs made it to the playlist this time.";
    $<HTMLButtonElement>("ended-save").hidden = n === 0;
  }

  // Songs that entered the playlist since last time fly into the pill.
  const played = new Set(st.playlist.map((p) => `${p.round}:${p.song.id}`));
  const winners = new Set(st.playlist.filter((p) => !known.has(`${p.round}:${p.song.id}`)).map((p) => p.song.id));
  known = played;
  bubbles.update(ended ? [] : st.candidates, winners);
  $("empty").hidden = ended || st.candidates.length > 0;

  const upcoming = st.playlist.filter((p) => p.startAt > now);
  $("next-empty").textContent = st.base
    ? `The winner of this round plays next. No votes? Something from “${st.base.name}” plays.`
    : "The winner of this round plays next.";
  const history = st.playlist.filter((p) => p.endAt <= now).reverse().slice(0, 8);
  const sig = JSON.stringify([upcoming.map((p) => p.startAt), history.map((p) => p.endAt), st.base?.name]);
  if (sig !== lastQueueSig) {
    lastQueueSig = sig;
    const auto = (p: PlaylistEntry) => (p.source === "base" ? `<span class="tag" title="From the base playlist">auto</span>` : "");
    $("next").innerHTML = upcoming
      .map((p) => row(p, `${auto(p)}<span class="when" data-start="${p.startAt}"></span>`))
      .join("");
    $("played").innerHTML = history
      .map((p) => row(p, p.skipped ? `<span class="tag">skipped</span>` : auto(p)))
      .join("");
    $("next-empty").hidden = upcoming.length > 0;
  }
}

function tick() {
  const st = session.state();
  const now = session.now();

  const left = st.round.endsAt - now;
  const ended = st.endedAt !== null;
  $("round-label").textContent = ended ? "Session" : st.round.held ? "Queue full" : `Round ${st.round.index + 1}`;
  $("round-time").textContent = ended ? "ended" : st.round.held ? "votes rolling" : left > 0 ? fmtTime(left) : "closing…";
  const frac = ended || st.round.held ? 0 : Math.min(1, Math.max(0, left / session.cfg.roundMs));
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
    const skips = np.entry.skippers.length;
    $("pill-skip").hidden = skips === 0;
    $("pill-skip-count").textContent = `${skips}/${session.skipThreshold} skip`;
  } else {
    // Hidden via .idle; forget the song so the pill refreshes when the next one starts.
    $("pill-thumb").dataset.id = "";
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

// --- save to YouTube Music ---

const saveDialog = $<HTMLDialogElement>("save-dialog");
const saveGo = $<HTMLButtonElement>("save-go");
let toSave: Song[] = [];

function saveStatus(html: string, error = false) {
  const el = $("save-status");
  el.hidden = false;
  el.classList.toggle("error", error);
  el.innerHTML = html;
}

$("save").addEventListener("click", async () => {
  toSave = keepers(session.state().playlist, session.now());
  const { googleClientId } = await info;
  const date = new Date().toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });

  $("save-summary").textContent = toSave.length
    ? `${toSave.length} song${toSave.length === 1 ? "" : "s"} that played tonight, in order (skipped songs left out).`
    : "Nothing has made the playlist yet.";
  $("save-list").innerHTML = toSave
    .map((s) => `<li><b>${escapeHtml(s.title)}</b> · ${escapeHtml(s.artist)}</li>`)
    .join("");
  $<HTMLInputElement>("save-title").value = `${session.cfg.name} · ${date}`;

  const fallback = $<HTMLAnchorElement>("save-fallback");
  fallback.hidden = toSave.length === 0;
  fallback.href = watchVideosUrl(toSave.map((s) => s.id));
  fallback.textContent =
    toSave.length > WATCH_VIDEOS_LIMIT ? `Open the first ${WATCH_VIDEOS_LIMIT} on YouTube instead` : "Open on YouTube instead";

  $("save-oauth").hidden = !googleClientId;
  $("save-no-oauth").hidden = !!googleClientId;
  saveGo.hidden = !googleClientId;
  saveGo.disabled = toSave.length === 0;
  saveGo.textContent = "Sign in with Google and save";
  $("save-progress").hidden = true;
  $("save-status").hidden = true;
  // Load Google's script now, so the sign-in popup opens directly from the Save click.
  if (googleClientId) loadGoogleIdentity().catch(() => {});
  saveDialog.showModal();
});

saveGo.addEventListener("click", async () => {
  const { googleClientId } = await info;
  if (!googleClientId || !toSave.length) return;
  if (saveGo.dataset.done) return saveDialog.close();
  saveGo.disabled = true;
  const bar = $("save-bar");
  try {
    saveStatus("Waiting for Google sign-in…");
    await loadGoogleIdentity();
    const token = await requestToken(googleClientId);

    saveStatus("Creating playlist…");
    const title = $<HTMLInputElement>("save-title").value.trim() || session.cfg.name;
    const privacy = $<HTMLSelectElement>("save-privacy").value as Privacy;
    const date = new Date().toLocaleDateString();
    const id = await createPlaylist(token, {
      title,
      description: `Crowd-voted at ${session.cfg.name} on ${date} with audia.`,
      privacy,
    });

    $("save-progress").hidden = false;
    bar.style.width = "0%";
    const { added, failed } = await addVideos(token, id, toSave.map((s) => s.id), (done) => {
      bar.style.width = `${(done / toSave.length) * 100}%`;
      saveStatus(`Adding songs… ${done}/${toSave.length}`);
    });

    const missing = failed.length ? ` ${failed.length} couldn't be added (not available on YouTube).` : "";
    saveStatus(`Saved ${added} songs.${missing} <a href="${playlistUrl(id)}" target="_blank" rel="noopener">Open in YouTube Music</a>`);
    saveGo.dataset.done = "1";
    saveGo.textContent = "Done";
  } catch (e) {
    saveStatus(escapeHtml(explain(e)), true);
    saveGo.textContent = "Try again";
  } finally {
    saveGo.disabled = false;
  }
});

saveDialog.addEventListener("close", () => delete saveGo.dataset.done);
$("ended-save").addEventListener("click", () => $("save").click());

// --- base playlist ---

const baseDialog = $<HTMLDialogElement>("base-dialog");
const baseGo = $<HTMLButtonElement>("base-go");
let loadedBase: { name: string; songs: Song[] } | null = null;

function baseStatus(text: string, error = false) {
  const el = $("base-status");
  el.hidden = false;
  el.classList.toggle("error", error);
  el.textContent = text;
}

function renderBaseDialog() {
  const current = session.state().base;
  $("base-current").innerHTML = current
    ? `Now: <b>${escapeHtml(current.name)}</b> · ${current.songs} songs`
    : "No base playlist yet. Silence when nobody votes.";
  $<HTMLButtonElement>("base-remove").hidden = !current;
  baseGo.textContent = loadedBase ? "Use as base playlist" : "Load";
}

$("base").addEventListener("click", () => {
  loadedBase = null;
  $<HTMLInputElement>("base-url").value = "";
  for (const id of ["base-preview", "base-list", "base-status"]) $(id).hidden = true;
  renderBaseDialog();
  baseDialog.showModal();
});

$("base-url").addEventListener("input", () => {
  // A new link invalidates the preview.
  loadedBase = null;
  $("base-preview").hidden = $("base-list").hidden = true;
  renderBaseDialog();
});
$("base-url").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    baseGo.click();
  }
});

baseGo.addEventListener("click", async () => {
  baseGo.disabled = true;
  try {
    if (!loadedBase) {
      const link = $<HTMLInputElement>("base-url").value.trim();
      if (!link) return baseStatus("Paste a playlist link first.", true);
      baseStatus("Reading playlist…");
      const res = await fetch(`/api/playlist?list=${encodeURIComponent(link)}`);
      const data = await res.json();
      if (!res.ok) return baseStatus(data.error ?? "Couldn't read that playlist.", true);
      loadedBase = data as { name: string; songs: Song[] };
      $("base-preview").hidden = false;
      $("base-preview").innerHTML = `<b>${escapeHtml(loadedBase.name)}</b> · ${loadedBase.songs.length} songs`;
      const shown = loadedBase.songs.slice(0, 8);
      const more = loadedBase.songs.length - shown.length;
      $("base-list").hidden = false;
      $("base-list").innerHTML =
        shown.map((s) => `<li><b>${escapeHtml(s.title)}</b> · ${escapeHtml(s.artist)}</li>`).join("") +
        (more > 0 ? `<li>…and ${more} more</li>` : "");
      $("base-status").hidden = true;
    } else {
      baseStatus("Sharing with everyone…");
      await session.setBase(loadedBase.songs, loadedBase.name);
      baseStatus(`Done. Songs from “${loadedBase.name}” play whenever nobody votes.`);
      loadedBase = null;
    }
    renderBaseDialog();
  } catch (e) {
    baseStatus((e as Error).message, true);
  } finally {
    baseGo.disabled = false;
  }
});

$("base-remove").addEventListener("click", async () => {
  try {
    await session.setBase([], "");
    baseStatus("Base playlist removed.");
    renderBaseDialog();
  } catch (e) {
    baseStatus((e as Error).message, true);
  }
});

// --- ending the session ---

$("end-session").addEventListener("click", async () => {
  if (!confirm("End the session for everyone? Voting stops and the music ends. You can still save the playlist afterwards.")) return;
  try {
    await session.end();
    // Stop handing the session out to new visitors.
    await fetch("/api/session", { method: "DELETE" }).catch(() => {});
    renderQr();
    renderState();
    tick();
  } catch (e) {
    alert((e as Error).message);
  }
});

// --- collapsible side panel ---

const SIDE_KEY = "audia.sideCollapsed";
function setSideCollapsed(collapsed: boolean) {
  document.body.classList.toggle("side-collapsed", collapsed);
  const btn = $("side-toggle");
  const label = collapsed ? "Show panel" : "Hide panel";
  btn.setAttribute("aria-label", label);
  btn.title = `${label} (P)`;
  localStorage.setItem(SIDE_KEY, collapsed ? "1" : "");
}
setSideCollapsed(localStorage.getItem(SIDE_KEY) === "1");
$("side-toggle").addEventListener("click", () => setSideCollapsed(!document.body.classList.contains("side-collapsed")));
document.addEventListener("keydown", (e) => {
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || saveDialog.open;
  if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "p") {
    setSideCollapsed(!document.body.classList.contains("side-collapsed"));
  }
});

$("new-session").addEventListener("click", () => {
  if (confirm("Start a new session? Current votes and playlist stay with the old one.")) {
    location.href = "/display?new";
  }
});
$("ended-new").addEventListener("click", () => (location.href = "/display?new"));

// --- boot ---

const { ticket, fresh } = await resolveTicket();
session = await Session.start(
  ticket,
  (s) => {
    session = s;
    renderStatus();
  },
  { host: fresh },
);
if (!session.isHost) {
  for (const id of ["end-session", "base"]) {
    const btn = $<HTMLButtonElement>(id);
    btn.disabled = true;
    btn.title = "Only the display (browser) that started this session can do this";
  }
}
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
