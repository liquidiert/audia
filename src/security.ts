import { createPublicKey, verify } from "node:crypto";
import { isIP } from "node:net";

// --- Response headers ---

/**
 * Enforced policy that can't break the app (framing, plugins, base/form hijacking),
 * plus a full policy in report-only mode: violations are logged via /api/csp-report
 * so it can be tightened and enforced once real traffic shows it's complete.
 */
const CSP_ENFORCED = "frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'";
const CSP_REPORT_ONLY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' https://www.youtube.com https://s.ytimg.com https://accounts.google.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "connect-src 'self' https://*.iroh.link wss://*.iroh.link https://www.googleapis.com https://accounts.google.com",
  "frame-src https://www.youtube.com https://www.youtube-nocookie.com https://accounts.google.com",
  "worker-src 'self' blob:",
  "report-uri /api/csp-report",
].join("; ");

export const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "cross-origin-opener-policy": "same-origin-allow-popups",
  "content-security-policy": CSP_ENFORCED,
  "content-security-policy-report-only": CSP_REPORT_ONLY,
};

/** Copy of `res` with the security headers added (API responses are also same-origin only). */
export function withSecurityHeaders(res: Response, api = false): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!headers.has(k)) headers.set(k, v);
  if (api) headers.set("cross-origin-resource-policy", "same-origin");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// --- Cross-site request forgery ---

/**
 * Browsers attach Basic auth credentials to cross-site requests too, so a page on
 * another site could make a logged-in display change things. State-changing
 * requests must come from our own pages: same-origin per Sec-Fetch-Site / Origin,
 * and with a JSON body (which cross-site forms can't send without a CORS preflight).
 */
export function crossSiteRejection(req: Request): Response | null {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return null;
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    return Response.json({ error: "cross-site request refused" }, { status: 403 });
  }
  const origin = req.headers.get("origin");
  if (!site && origin && origin !== "null") {
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    if (!host || new URL(origin).host !== host) {
      return Response.json({ error: "cross-site request refused" }, { status: 403 });
    }
  }
  if (req.method !== "DELETE" && !req.headers.get("content-type")?.startsWith("application/json")) {
    return Response.json({ error: "expected a JSON body" }, { status: 415 });
  }
  return null;
}

// --- Client addresses ---

function isPrivate(ip: string): boolean {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return ip === "::1" || ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80");
}

/**
 * Client address for rate limiting. X-Forwarded-For is only trusted when the direct
 * peer is a private address (our reverse proxy, e.g. Traefik), and then only its
 * right-most entry, the one the proxy added: anything further left is client-supplied.
 */
export function clientAddress(req: Request, socketIp: string | undefined): string {
  const direct = socketIp ?? "unknown";
  const xff = req.headers.get("x-forwarded-for");
  if (xff && socketIp && isPrivate(socketIp)) {
    const last = xff.split(",").map((s) => s.trim()).filter(Boolean).at(-1);
    if (last && isIP(last)) return last;
  }
  return direct;
}

// --- Rate limiting ---

/** Fixed-window counter per key, with a bounded number of tracked keys. */
export function rateLimiter({ limit, windowMs, maxKeys = 10_000, now = Date.now }: {
  limit: number;
  windowMs: number;
  maxKeys?: number;
  now?: () => number;
}) {
  const hits = new Map<string, { count: number; since: number }>();
  return (key: string): boolean => {
    const t = now();
    let h = hits.get(key);
    if (!h || t - h.since >= windowMs) {
      if (!h && hits.size >= maxKeys) {
        for (const [k, v] of hits) if (t - v.since >= windowMs) hits.delete(k);
        if (hits.size >= maxKeys) hits.delete(hits.keys().next().value!);
      }
      h = { count: 0, since: t };
      hits.set(key, h);
    }
    h.count++;
    return h.count <= limit;
  };
}

// --- Logging ---

/** Strip control characters (newlines, ANSI escapes) from untrusted text before logging it. */
export const logSafe = (v: unknown, max = 80): string =>
  (typeof v === "string" ? v : String(v)).replace(/[\u0000-\u001f\u007f-\u009f]/g, "?").slice(0, max);

// --- Signed heartbeats ---

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
/** How far a heartbeat's timestamp may be from the server clock. */
export const HEARTBEAT_MAX_SKEW_MS = 2 * 60_000;

export const isEndpointId = (id: unknown): id is string => typeof id === "string" && /^[0-9a-f]{64}$/.test(id);

export function isRelayUrl(v: unknown): v is string {
  if (typeof v !== "string" || v.length > 200) return false;
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
}

export { heartbeatMessage } from "./shared/protocol";

/** Verify an ed25519 signature made by an iroh endpoint (its id is the hex public key). */
export function verifyEndpointSignature(id: string, message: string, sigHex: string): boolean {
  if (!isEndpointId(id) || !/^[0-9a-f]{128}$/.test(sigHex)) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(id, "hex")]), format: "der", type: "spki" });
    return verify(null, Buffer.from(message), key, Buffer.from(sigHex, "hex"));
  } catch {
    return false;
  }
}
