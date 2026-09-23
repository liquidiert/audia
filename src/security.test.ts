import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  clientAddress,
  crossSiteRejection,
  heartbeatMessage,
  isRelayUrl,
  logSafe,
  rateLimiter,
  verifyEndpointSignature,
  withSecurityHeaders,
} from "./security";

const req = (method: string, headers: Record<string, string> = {}) =>
  new Request("http://audia.test/api/x", { method, headers: { host: "audia.test", ...headers } });

describe("cross-site requests", () => {
  test("reads are always fine", () => {
    expect(crossSiteRejection(req("GET", { "sec-fetch-site": "cross-site" }))).toBeNull();
  });

  test("same-origin JSON writes pass", () => {
    const r = req("POST", { "sec-fetch-site": "same-origin", "content-type": "application/json" });
    expect(crossSiteRejection(r)).toBeNull();
    expect(crossSiteRejection(req("DELETE", { "sec-fetch-site": "same-origin" }))).toBeNull();
  });

  test("cross-site writes are refused, even as JSON", () => {
    for (const site of ["cross-site", "same-site"]) {
      expect(crossSiteRejection(req("PUT", { "sec-fetch-site": site, "content-type": "application/json" }))?.status).toBe(403);
    }
  });

  test("a foreign Origin is refused when Sec-Fetch-Site is missing", () => {
    const r = req("POST", { origin: "https://evil.example", "content-type": "application/json" });
    expect(crossSiteRejection(r)?.status).toBe(403);
    const ok = req("POST", { origin: "http://audia.test", "content-type": "application/json" });
    expect(crossSiteRejection(ok)).toBeNull();
  });

  test("form-style bodies (no preflight) are refused", () => {
    expect(crossSiteRejection(req("POST", { "sec-fetch-site": "same-origin", "content-type": "text/plain" }))?.status).toBe(415);
  });
});

describe("client address", () => {
  const withXff = (xff: string) => new Request("http://x/", { headers: { "x-forwarded-for": xff } });

  test("behind a private proxy, the proxy-added (right-most) entry counts", () => {
    expect(clientAddress(withXff("6.6.6.6, 203.0.113.9"), "10.0.1.5")).toBe("203.0.113.9");
  });

  test("a spoofed header from a public client is ignored", () => {
    expect(clientAddress(withXff("1.2.3.4"), "198.51.100.7")).toBe("198.51.100.7");
  });
});

describe("rate limiter", () => {
  test("allows up to the limit per window and key", () => {
    let t = 0;
    const allow = rateLimiter({ limit: 2, windowMs: 1000, now: () => t });
    expect([allow("a"), allow("a"), allow("a"), allow("b")]).toEqual([true, true, false, true]);
    t = 1000;
    expect(allow("a")).toBe(true);
  });

  test("tracks a bounded number of keys", () => {
    const allow = rateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 3 });
    for (let i = 0; i < 100; i++) allow(`k${i}`);
    expect(allow("fresh")).toBe(true);
  });
});

describe("misc", () => {
  test("log text can't inject lines or escape codes", () => {
    expect(logSafe("ok\nsession ended\u001b[31m")).toBe("ok?session ended?[31m");
  });

  test("relays must be https URLs", () => {
    expect(isRelayUrl("https://euc1-1.relay.n0.iroh.link./")).toBe(true);
    expect(isRelayUrl("javascript:alert(1)")).toBe(false);
    expect(isRelayUrl("ws://evil.example")).toBe(false);
  });

  test("security headers are added without clobbering existing ones", async () => {
    const res = withSecurityHeaders(new Response("x", { headers: { "content-type": "text/plain" } }), true);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(await res.text()).toBe("x");
  });
});

describe("heartbeat signatures", () => {
  // Same key format as iroh: the endpoint id is the hex ed25519 public key.
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const id = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const msg = heartbeatMessage("topic", id, "https://relay.example/", 123);
  const sig = sign(null, Buffer.from(msg), privateKey).toString("hex");

  test("a peer's own signature verifies", () => {
    expect(verifyEndpointSignature(id, msg, sig)).toBe(true);
  });

  test("a different relay, id or junk fails", () => {
    expect(verifyEndpointSignature(id, heartbeatMessage("topic", id, "https://evil.example/", 123), sig)).toBe(false);
    expect(verifyEndpointSignature("ab".repeat(32), msg, sig)).toBe(false);
    expect(verifyEndpointSignature(id, msg, "zz")).toBe(false);
  });
});
