import { describe, expect, test } from "bun:test";
import { addVideos, createPlaylist, explain, watchVideosUrl, YouTubeError } from "./youtube";

type Reply = { status: number; body?: unknown };

/** Fake fetch that answers from a queue and records every request. */
function fakeFetch(replies: Reply[]) {
  const calls: { url: string; body: any; auth: string | null }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get("authorization") });
    const r = replies.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const apiError = (status: number, reason: string) => ({
  status,
  body: { error: { message: reason, errors: [{ reason }] } },
});
const noSleep = async () => {};

describe("youtube", () => {
  test("createPlaylist sends title, description and privacy", async () => {
    const f = fakeFetch([{ status: 200, body: { id: "PL123" } }]);
    const id = await createPlaylist("tok", { title: "Party", description: "d", privacy: "unlisted" }, f.impl);
    expect(id).toBe("PL123");
    expect(f.calls[0]!.url).toContain("/playlists?part=snippet,status");
    expect(f.calls[0]!.auth).toBe("Bearer tok");
    expect(f.calls[0]!.body).toEqual({ snippet: { title: "Party", description: "d" }, status: { privacyStatus: "unlisted" } });
  });

  test("addVideos inserts in order, retries transient errors and skips refused videos", async () => {
    const f = fakeFetch([
      { status: 200 },
      apiError(409, "SERVICE_UNAVAILABLE"),
      { status: 200 },
      apiError(404, "videoNotFound"),
      { status: 200 },
    ]);
    const progress: number[] = [];
    const res = await addVideos("tok", "PL1", ["a", "b", "c", "d"], (done) => progress.push(done), f.impl, noSleep);
    expect(res).toEqual({ added: 3, failed: ["c"] });
    expect(f.calls.map((c) => c.body.snippet.resourceId.videoId)).toEqual(["a", "b", "b", "c", "d"]);
    expect(progress).toEqual([1, 2, 3, 4]);
  });

  test("quota errors abort instead of silently skipping everything", async () => {
    const f = fakeFetch([{ status: 200 }, apiError(403, "quotaExceeded")]);
    const err = await addVideos("tok", "PL1", ["a", "b", "c"], () => {}, f.impl, noSleep).catch((e) => e);
    expect(err).toBeInstanceOf(YouTubeError);
    expect(explain(err)).toContain("quota");
    expect(f.calls).toHaveLength(2);
  });

  test("watch_videos fallback caps at 50 ids", () => {
    const ids = Array.from({ length: 60 }, (_, i) => `v${i}`);
    const url = new URL(watchVideosUrl(ids));
    expect(url.searchParams.get("video_ids")!.split(",")).toHaveLength(50);
  });
});
