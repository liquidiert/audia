import { describe, expect, test } from "bun:test";
import { basicAuth, decodePasswordHash } from "./auth";

// Cheap parameters keep the test fast; production hashes use Bun's defaults.
const hash = await Bun.password.hash("s3cret", { algorithm: "argon2id", memoryCost: 1024, timeCost: 1 });

const req = (user?: string, pass?: string) =>
  new Request("http://x/display", {
    headers: user === undefined ? {} : { authorization: `Basic ${btoa(`${user}:${pass}`)}` },
  });

describe("basic auth", () => {
  test("hashes are salted: same password, different hash", async () => {
    const again = await Bun.password.hash("s3cret", { algorithm: "argon2id", memoryCost: 1024, timeCost: 1 });
    expect(again).not.toBe(hash);
    expect(await Bun.password.verify("s3cret", again)).toBe(true);
  });

  test("accepts the right credentials and challenges everything else", async () => {
    const auth = basicAuth({ user: "dj", passwordHash: hash });
    expect(await auth.check(req("dj", "s3cret"), "a")).toBeNull();
    for (const r of [req(), req("dj", "wrong"), req("other", "s3cret")]) {
      const res = await auth.check(r, "b");
      expect(res?.status).toBe(401);
      expect(res?.headers.get("www-authenticate")).toContain("Basic");
    }
  });

  test("passwords may contain colons", async () => {
    const h = await Bun.password.hash("a:b:c", { algorithm: "argon2id", memoryCost: 1024, timeCost: 1 });
    expect(await basicAuth({ user: "dj", passwordHash: h }).check(req("dj", "a:b:c"), "a")).toBeNull();
  });

  test("rate-limits repeated failures per client, then recovers", async () => {
    let t = 0;
    const auth = basicAuth({ user: "dj", passwordHash: hash, now: () => t });
    for (let i = 0; i < 10; i++) expect((await auth.check(req("dj", "nope"), "evil"))?.status).toBe(401);
    expect((await auth.check(req("dj", "s3cret"), "evil"))?.status).toBe(429);
    expect(await auth.check(req("dj", "s3cret"), "friend")).toBeNull();
    t += 11 * 60_000;
    expect(await auth.check(req("dj", "s3cret"), "evil")).toBeNull();
  });

  test("disabled without a hash", async () => {
    const auth = basicAuth({ user: "dj", passwordHash: null });
    expect(auth.enabled).toBe(false);
    expect(await auth.check(req(), "a")).toBeNull();
  });

  test("hash env var accepts raw or base64 form", () => {
    expect(decodePasswordHash(hash)).toBe(hash);
    expect(decodePasswordHash(Buffer.from(hash).toString("base64"))).toBe(hash);
    expect(decodePasswordHash(undefined)).toBeNull();
    expect(() => decodePasswordHash("plaintext-password")).toThrow();
  });
});
