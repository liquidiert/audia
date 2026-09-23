import { createHash, timingSafeEqual } from "node:crypto";

/** Failed attempts allowed per client within `FAIL_WINDOW_MS` before answering 429. */
const MAX_FAILURES = 10;
const FAIL_WINDOW_MS = 10 * 60_000;
/** Remember this many verified Authorization headers so argon2 runs once per session, not per request. */
const CACHE_SIZE = 64;

const sha256 = (s: string) => createHash("sha256").update(s).digest();

/**
 * `DISPLAY_PASSWORD_HASH` holds a salted `Bun.password` hash (argon2id by default).
 * `scripts/hash-password.ts` prints it base64-encoded, because raw hashes contain `$`,
 * which env tooling likes to interpolate. Raw `$argon2…`/`$2b$…` strings work too.
 */
export function decodePasswordHash(value: string | undefined): string | null {
  const v = value?.trim();
  if (!v) return null;
  if (v.startsWith("$")) return v;
  const decoded = Buffer.from(v, "base64").toString("utf8");
  if (!decoded.startsWith("$")) throw new Error("DISPLAY_PASSWORD_HASH is neither a password hash nor base64 of one");
  return decoded;
}

export interface BasicAuthOptions {
  user: string;
  /** Decoded password hash; `null` disables the guard. */
  passwordHash: string | null;
  realm?: string;
  now?: () => number;
}

/**
 * HTTP Basic auth against a salted password hash.
 * `check()` returns `null` when the request may proceed, otherwise the response to send.
 */
export function basicAuth({ user, passwordHash, realm = "audia display", now = Date.now }: BasicAuthOptions) {
  const verified = new Set<string>();
  const failures = new Map<string, { count: number; since: number }>();
  const expectedUser = sha256(user);

  const challenge = () =>
    new Response("Authentication required", {
      status: 401,
      headers: { "www-authenticate": `Basic realm="${realm}", charset="UTF-8"` },
    });

  async function check(req: Request, client: string): Promise<Response | null> {
    if (!passwordHash) return null;

    const header = req.headers.get("authorization") ?? "";
    const key = sha256(header).toString("hex");
    if (verified.has(key)) return null;

    const f = failures.get(client);
    if (f && now() - f.since < FAIL_WINDOW_MS && f.count >= MAX_FAILURES) {
      return new Response("Too many failed attempts, try again later", { status: 429 });
    }
    if (!header.startsWith("Basic ")) return challenge();

    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const sep = decoded.indexOf(":");
    const name = sep >= 0 ? decoded.slice(0, sep) : "";
    const password = sep >= 0 ? decoded.slice(sep + 1) : "";

    // Always run the (slow) hash check so a wrong user name isn't faster than a wrong password.
    const userOk = timingSafeEqual(sha256(name), expectedUser);
    const passOk = await Bun.password.verify(password, passwordHash).catch(() => false);

    if (userOk && passOk) {
      failures.delete(client);
      if (verified.size >= CACHE_SIZE) verified.delete(verified.values().next().value!);
      verified.add(key);
      return null;
    }
    const entry = f && now() - f.since < FAIL_WINDOW_MS ? f : { count: 0, since: now() };
    entry.count++;
    failures.set(client, entry);
    return challenge();
  }

  return { check, enabled: !!passwordHash };
}

/** Client address for rate limiting; trusts the first X-Forwarded-For hop (Traefik sets it). */
export function clientAddress(req: Request, fallback: string | undefined): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || fallback || "unknown";
}
