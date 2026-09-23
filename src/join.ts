import { randomBytes, timingSafeEqual } from "node:crypto";
import { decodeTicket, encodeTicket, type Ticket } from "./shared/protocol";

/**
 * Per-session join tokens. The display's QR code points at `/join/<token>`, which
 * sets an HttpOnly cookie; the phone page and its APIs require that cookie, so the
 * voting page can only be reached by scanning the code of the running session.
 * A new or ended session invalidates the token.
 */

export const JOIN_COOKIE = "audia_join";
/** The cookie outlives any party; validity really comes from matching the session's token. */
const COOKIE_MAX_AGE_S = 2 * 24 * 60 * 60;

export const newJoinToken = () => randomBytes(24).toString("base64url");

export function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/** Behind Traefik the app sees plain HTTP; the original scheme is in X-Forwarded-Proto. */
export function isSecure(req: Request): boolean {
  return req.headers.get("x-forwarded-proto") === "https" || new URL(req.url).protocol === "https:";
}

export function joinCookie(token: string, secure: boolean): string {
  return `${JOIN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_S}${secure ? "; Secure" : ""}`;
}

const sameToken = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Whether the request carries the join cookie for the current session. */
export function hasJoined(req: Request, token: string | null): boolean {
  const cookie = readCookie(req, JOIN_COOKIE);
  return !!token && !!cookie && sameToken(cookie, token);
}

export function tokenMatches(candidate: string, token: string | null): boolean {
  return !!token && sameToken(candidate, token);
}

/** What the server keeps on disk: the session ticket and its join token. */
export interface StoredSession {
  ticket: Ticket;
  joinToken: string;
}

export function serializeSession(s: StoredSession): string {
  return JSON.stringify({ ticket: encodeTicket(s.ticket), joinToken: s.joinToken });
}

/** Reads the session file; files from before join tokens (a bare ticket) get a fresh token. */
export function parseSession(text: string): StoredSession | null {
  const raw = text.trim();
  if (!raw) return null;
  if (raw.startsWith("{")) {
    try {
      const d = JSON.parse(raw) as { ticket?: string; joinToken?: string };
      const ticket = decodeTicket(d.ticket ?? "");
      if (ticket && typeof d.joinToken === "string" && d.joinToken.length >= 16) return { ticket, joinToken: d.joinToken };
    } catch {}
    return null;
  }
  const ticket = decodeTicket(raw);
  return ticket ? { ticket, joinToken: newJoinToken() } : null;
}

const ICON = `<svg viewBox="0 0 32 32" width="56" height="56" aria-hidden="true"><defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="2" y1="3" x2="30" y2="30"><stop offset="0" stop-color="#ff4f7b"/><stop offset="1" stop-color="#7b5cff"/></linearGradient></defs><g fill="url(#g)"><path d="M10.2 7.6 28.8 3.2v4.6L10.2 12.2z"/><rect x="10.2" y="9" width="2.6" height="10.4"/><rect x="26.2" y="5" width="2.6" height="10.4"/><circle cx="8.6" cy="19.4" r="4.2"/><path d="M1.6 30.6c0-4.4 3.2-6 7-6s7 1.6 7 6z"/><circle cx="24.6" cy="15.4" r="4.2"/><path d="M17.6 26.6c0-4.4 3.2-6 7-6s7 1.6 7 6z"/></g></svg>`;

/** Shown instead of the voting page to anyone without a valid join cookie. */
export function gatePage(title: string, text: string, status = 403): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" /><meta name="theme-color" content="#0b0b12" />
<title>audia</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b12;color:#f2f2f7;
font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;text-align:center;padding:24px;box-sizing:border-box}
h1{font-size:26px;margin:18px 0 8px;letter-spacing:-.5px}p{color:#9a9ab0;margin:0;max-width:320px}
</style></head><body><main>${ICON}<h1>${title}</h1><p>${text}</p></main></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
