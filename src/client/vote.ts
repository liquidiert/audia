import { Session, escapeHtml, fmtTime, installThumbFallback } from "./session";
import { keepers, votesOf } from "../shared/state";
import type { Song } from "../shared/types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const statusEl = $("status");
const roundEl = $("round");
const q = $<HTMLInputElement>("q");
const clearBtn = $<HTMLButtonElement>("clear");
const resultsSec = $("results");
const resultList = $("result-list");
const candidateList = $("candidate-list");
const votesLeft = $("votes-left");
const emptyEl = $("empty");
const nextSec = $("next-section");
const nextList = $("next-list");
const nowEl = $("now");

installThumbFallback();

let session: Session | null = null;
let results: Song[] = [];

function toast(msg: string) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout((toast as any).timer);
  (toast as any).timer = setTimeout(() => (t.hidden = true), 2200);
}

function renderStatus() {
  if (!session) return;
  statusEl.dataset.status = session.status;
  const n = session.neighbors.size;
  statusEl.textContent =
    session.status === "online" ? `${n} peer${n === 1 ? "" : "s"}` : session.status === "connecting" ? "connecting…" : session.status;
}

const thumb = (s: Song) =>
  `<img src="${escapeHtml(s.thumb ?? "")}" data-vid="${escapeHtml(s.id)}" alt="" loading="lazy" />`;

let lastSig = "";

function renderLists() {
  if (!session) return;
  const st = session.state();
  const mine = votesOf(st, session.id);
  const now = session.now();
  const upcoming = st.playlist.filter((p) => p.startAt > now);
  // Only touch the DOM when something visible changed, so taps don't hit replaced buttons.
  const sig = JSON.stringify([
    st.endedAt,
    st.candidates.map((c) => [c.song.id, c.votes]),
    [...mine],
    upcoming.map((p) => p.startAt),
  ]);
  if (sig === lastSig) return;
  lastSig = sig;

  const ended = st.endedAt !== null;
  document.body.classList.toggle("session-ended", ended);
  $("ended").hidden = !ended;
  if (ended) {
    const played = keepers(st.playlist, now);
    $("ended-list").innerHTML = played.length
      ? played
          .map(
            (s) => `
      <li class="song">
        ${thumb(s)}
        <div class="meta">
          <div class="title">${escapeHtml(s.title)}</div>
          <div class="artist">${escapeHtml(s.artist)}</div>
        </div>
      </li>`,
          )
          .join("")
      : `<p class="muted">No songs made it this time.</p>`;
    return;
  }
  const max = Math.max(1, ...st.candidates.map((c) => c.votes));

  votesLeft.textContent = `${mine.size} / ${session.cfg.maxVotes} votes`;
  emptyEl.hidden = st.candidates.length > 0;
  candidateList.innerHTML = st.candidates
    .map(
      (c) => `
      <li class="song" data-id="${escapeHtml(c.song.id)}">
        <div class="fill" style="width:${(c.votes / max) * 100}%"></div>
        ${thumb(c.song)}
        <div class="meta">
          <div class="title">${escapeHtml(c.song.title)}</div>
          <div class="artist">${escapeHtml(c.song.artist)} · ${fmtTime(c.song.durationS * 1000)}</div>
        </div>
        <span class="count">${c.votes}</span>
        <button class="vote-btn ${mine.has(c.song.id) ? "on" : ""}" data-action="toggle" aria-label="Vote">♥</button>
      </li>`,
    )
    .join("");

  nextSec.hidden = upcoming.length === 0;
  nextList.innerHTML = upcoming
    .map(
      (p) => `
      <li class="song">
        ${thumb(p.song)}
        <div class="meta">
          <div class="title">${escapeHtml(p.song.title)}</div>
          <div class="artist">${escapeHtml(p.song.artist)}</div>
        </div>
        ${p.source === "base" ? `<span class="tag">auto</span>` : ""}
        <span class="when" data-start="${p.startAt}">in ${fmtTime(p.startAt - now)}</span>
      </li>`,
    )
    .join("");

  renderResults();
}

function renderResults() {
  resultsSec.hidden = results.length === 0;
  if (!session || results.length === 0) return;
  const st = session.state();
  const pooled = new Set(st.candidates.map((c) => c.song.id));
  const mine = votesOf(st, session.id);
  resultList.innerHTML = results
    .map((s, i) => {
      const cls = mine.has(s.id) ? "on" : pooled.has(s.id) ? "added" : "";
      const icon = mine.has(s.id) ? "♥" : "+";
      return `
      <li class="song" data-index="${i}">
        ${thumb(s)}
        <div class="meta">
          <div class="title">${escapeHtml(s.title)}</div>
          <div class="artist">${escapeHtml(s.artist)}${s.album ? ` · ${escapeHtml(s.album)}` : ""} · ${fmtTime(s.durationS * 1000)}</div>
        </div>
        <button class="vote-btn ${cls}" data-action="propose" aria-label="Propose and vote">${icon}</button>
      </li>`;
    })
    .join("");
}

function tick() {
  if (!session) return;
  const st = session.state();
  const now = session.now();
  const left = st.round.endsAt - now;
  roundEl.innerHTML = st.endedAt !== null
    ? "Session ended"
    : st.round.held
    ? `Queue is full · votes keep rolling`
    : left > 0
      ? `Round ${st.round.index + 1} closes in <b>${fmtTime(left)}</b>`
      : `Closing round ${st.round.index + 1}…`;

  for (const el of nextList.querySelectorAll<HTMLElement>("[data-start]")) {
    el.textContent = `in ${fmtTime(Number(el.dataset.start) - now)}`;
  }

  const np = st.nowPlaying;
  nowEl.hidden = !np;
  if (np) {
    const s = np.entry.song;
    const img = $<HTMLImageElement>("now-thumb");
    if (img.dataset.id !== s.id) {
      img.dataset.id = img.dataset.vid = s.id;
      delete img.dataset.fallback;
      img.style.visibility = "";
      img.src = s.thumb ?? "";
      $("now-title").textContent = s.title;
      $("now-artist").textContent = s.artist;
    }
    $("now-bar").style.width = `${Math.min(100, (np.positionMs / (s.durationS * 1000)) * 100)}%`;
    const skipBtn = $("skip");
    const voted = np.entry.skippers.includes(session.id);
    skipBtn.classList.toggle("on", voted);
    skipBtn.setAttribute("aria-label", voted ? "You voted to skip" : "Vote to skip");
    $("skip-count").textContent = `${np.entry.skippers.length}/${session.skipThreshold}`;
  }
}

// --- search ---

let searchSeq = 0;
let debounce: ReturnType<typeof setTimeout> | undefined;

async function runSearch(term: string) {
  const seq = ++searchSeq;
  if (!term) {
    results = [];
    renderResults();
    return;
  }
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(term)}`);
    const data = await res.json();
    if (seq !== searchSeq) return;
    if (!res.ok) throw new Error(data.error ?? "search failed");
    results = data;
    renderResults();
  } catch (e) {
    if (seq === searchSeq) toast(`Search failed: ${(e as Error).message}`);
  }
}

q.addEventListener("input", () => {
  clearBtn.hidden = !q.value;
  clearTimeout(debounce);
  debounce = setTimeout(() => runSearch(q.value.trim()), 350);
});
$("search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  clearTimeout(debounce);
  q.blur();
  runSearch(q.value.trim());
});
clearBtn.addEventListener("click", () => {
  q.value = "";
  clearBtn.hidden = true;
  runSearch("");
});

// --- voting ---

document.addEventListener("click", async (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-action]");
  if (!btn || !session) return;
  const li = btn.closest<HTMLElement>("li")!;
  const st = session.state();
  const mine = votesOf(st, session.id);
  const full = mine.size >= session.cfg.maxVotes;

  try {
    if (btn.dataset.action === "toggle") {
      const id = li.dataset.id!;
      const on = !mine.has(id);
      if (on && full) toast(`Only ${session.cfg.maxVotes} votes count — your oldest one moves here`);
      await session.vote(id, on);
    } else {
      const song = results[Number(li.dataset.index)]!;
      if (mine.has(song.id)) {
        await session.vote(song.id, false);
      } else {
        if (full) toast(`Only ${session.cfg.maxVotes} votes count — your oldest one moves here`);
        else toast(`Voted for “${song.title}”`);
        await session.propose(song);
      }
    }
  } catch (err) {
    toast(`Could not send vote: ${(err as Error).message}`);
  }
});

$("skip").addEventListener("click", async () => {
  if (!session) return;
  const entry = session.state().nowPlaying?.entry;
  if (!entry) return;
  if (entry.skippers.includes(session.id)) return toast("You already voted to skip this one");
  try {
    await session.skip();
    const left = session.skipThreshold - entry.skippers.length - 1;
    toast(left > 0 ? `Skip vote counted — ${left} more needed` : `Skipping “${entry.song.title}”`);
    tick();
  } catch (err) {
    toast(`Could not send skip vote: ${(err as Error).message}`);
  }
});

// --- boot ---

const ticket = await Session.findTicket();
if (!ticket) {
  document.querySelector("main")!.innerHTML =
    `<div class="gate">No voting session right now.<br/>Scan the QR code on the big screen to join.</div>`;
  statusEl.textContent = "no session";
} else {
  session = await Session.start(ticket, (s) => {
    session = s;
    renderStatus();
  });
  session.subscribe(() => {
    renderStatus();
    renderLists();
  });
  renderStatus();
  renderLists();
  tick();
  setInterval(tick, 500);
  // Rounds close by time, so re-check lists even without new events.
  setInterval(renderLists, 1000);
}
