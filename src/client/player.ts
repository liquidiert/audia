/**
 * Optional audio via the YouTube IFrame API. The shared schedule is the source of
 * truth; the player just follows it (loads the current song, seeks on drift).
 */

declare global {
  interface Window {
    YT?: any;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const DRIFT_S = 2.5;

let apiReady: Promise<void> | null = null;

function loadApi(): Promise<void> {
  apiReady ??= new Promise((resolve) => {
    if (window.YT?.Player) return resolve();
    window.onYouTubeIframeAPIReady = () => resolve();
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(s);
  });
  return apiReady;
}

export class SyncedPlayer {
  private player: any;
  private ready = false;
  private videoId: string | null = null;
  onError?: (videoId: string, code: number) => void;

  static async create(el: HTMLElement): Promise<SyncedPlayer> {
    await loadApi();
    const p = new SyncedPlayer();
    await new Promise<void>((resolve) => {
      p.player = new window.YT.Player(el, {
        width: 320,
        height: 180,
        playerVars: { autoplay: 1, controls: 0, disablekb: 1, playsinline: 1, rel: 0 },
        events: {
          onReady: () => {
            p.ready = true;
            resolve();
          },
          onError: (e: { data: number }) => p.videoId && p.onError?.(p.videoId, e.data),
        },
      });
    });
    return p;
  }

  /** Call regularly with what should be playing right now. */
  sync(target: { videoId: string; positionS: number } | null) {
    if (!this.ready) return;
    if (!target) {
      if (this.videoId) this.player.stopVideo();
      this.videoId = null;
      return;
    }
    if (target.videoId !== this.videoId) {
      this.videoId = target.videoId;
      this.player.loadVideoById({ videoId: target.videoId, startSeconds: target.positionS });
      return;
    }
    const state = this.player.getPlayerState?.();
    if (state === window.YT.PlayerState.PAUSED || state === window.YT.PlayerState.CUED) this.player.playVideo();
    const t = this.player.getCurrentTime?.() ?? 0;
    if (Math.abs(t - target.positionS) > DRIFT_S) this.player.seekTo(target.positionS, true);
  }
}
