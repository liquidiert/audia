/**
 * Save songs to the user's YouTube account (playlists there also show up in
 * YouTube Music's library). Uses Google Identity Services' token flow entirely in
 * the browser, so the server never sees a token or secret, only the public client id.
 */

declare global {
  interface Window {
    google?: any;
  }
}

const GIS_SRC = "https://accounts.google.com/gsi/client";
const API = "https://www.googleapis.com/youtube/v3";
const SCOPE = "https://www.googleapis.com/auth/youtube";
/** `watch_videos` accepts at most this many ids. */
const WATCH_LIMIT = 50;

export type Privacy = "private" | "unlisted" | "public";

export class YouTubeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason?: string,
  ) {
    super(message);
  }
}

let gis: Promise<void> | null = null;

/** Load Google Identity Services ahead of the click, so the consent popup opens inside the user gesture. */
export function loadGoogleIdentity(): Promise<void> {
  gis ??= new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve();
    const s = document.createElement("script");
    s.src = GIS_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      gis = null;
      reject(new Error("Could not load Google sign-in"));
    };
    document.head.appendChild(s);
  });
  return gis;
}

/** Ask the user for permission to manage their YouTube playlists. Call from a click handler. */
export function requestToken(clientId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (resp: { access_token?: string; error?: string; error_description?: string }) => {
        if (resp.access_token) resolve(resp.access_token);
        else reject(new Error(resp.error_description ?? resp.error ?? "Google sign-in failed"));
      },
      error_callback: (err: { type?: string; message?: string }) =>
        reject(new Error(err.type === "popup_closed" ? "Sign-in window was closed" : (err.message ?? "Google sign-in failed"))),
    });
    client.requestAccessToken();
  });
}

async function call<T>(token: string, path: string, body: unknown, fetchImpl: typeof fetch): Promise<T> {
  const res = await fetchImpl(`${API}/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) {
    const reason = data?.error?.errors?.[0]?.reason as string | undefined;
    throw new YouTubeError(data?.error?.message ?? `YouTube API error ${res.status}`, res.status, reason);
  }
  return data as T;
}

export async function createPlaylist(
  token: string,
  opts: { title: string; description: string; privacy: Privacy },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const data = await call<{ id: string }>(
    token,
    "playlists?part=snippet,status",
    {
      snippet: { title: opts.title.slice(0, 150), description: opts.description.slice(0, 5000) },
      status: { privacyStatus: opts.privacy },
    },
    fetchImpl,
  );
  return data.id;
}

const retryable = (e: unknown) =>
  e instanceof YouTubeError && (e.status === 409 || e.status === 429 || e.status >= 500) && e.reason !== "quotaExceeded";

/**
 * Add videos one after another (parallel inserts come back out of order or
 * fail with 409). Transient errors are retried; videos YouTube refuses are
 * reported as failed and skipped. Quota and auth errors abort.
 */
export async function addVideos(
  token: string,
  playlistId: string,
  videoIds: string[],
  onProgress: (done: number, failed: string[]) => void = () => {},
  fetchImpl: typeof fetch = fetch,
  sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
): Promise<{ added: number; failed: string[] }> {
  const failed: string[] = [];
  let added = 0;
  for (const [i, videoId] of videoIds.entries()) {
    for (let attempt = 0; ; attempt++) {
      try {
        await call(
          token,
          "playlistItems?part=snippet",
          { snippet: { playlistId, resourceId: { kind: "youtube#video", videoId } } },
          fetchImpl,
        );
        added++;
        break;
      } catch (e) {
        if (retryable(e) && attempt < 4) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        const fatal = e instanceof YouTubeError && (e.status === 401 || e.status === 403 || e.reason === "quotaExceeded");
        if (fatal) throw e;
        failed.push(videoId);
        break;
      }
    }
    onProgress(i + 1, failed);
  }
  return { added, failed };
}

export const playlistUrl = (id: string) => `https://music.youtube.com/playlist?list=${encodeURIComponent(id)}`;

/** No-login fallback: YouTube builds a temporary playlist from these ids, which can then be saved there. */
export function watchVideosUrl(videoIds: string[]): string {
  return `https://www.youtube.com/watch_videos?video_ids=${videoIds.slice(0, WATCH_LIMIT).join(",")}`;
}

export const WATCH_VIDEOS_LIMIT = WATCH_LIMIT;

/** Human-readable explanation for common API failures. */
export function explain(e: unknown): string {
  if (e instanceof YouTubeError) {
    if (e.reason === "quotaExceeded") return "YouTube's daily API quota is used up. Try again tomorrow or use the link below.";
    if (e.reason === "youtubeSignupRequired") return "This Google account has no YouTube channel yet. Create one on youtube.com first.";
    if (e.status === 401) return "Google sign-in expired. Try again.";
    if (e.status === 403) return `YouTube refused the request: ${e.message}`;
  }
  return (e as Error)?.message ?? String(e);
}
