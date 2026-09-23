import { describe, expect, test } from "bun:test";
import {
  JOIN_COOKIE,
  hasJoined,
  joinCookie,
  newJoinToken,
  parseSession,
  readCookie,
  serializeSession,
  tokenMatches,
} from "./join";
import { encodeTicket, newSessionConfig } from "./shared/protocol";

const withCookie = (cookie?: string) => new Request("http://x/", { headers: cookie ? { cookie } : {} });

describe("join tokens", () => {
  test("tokens are long, random and URL-safe", () => {
    const a = newJoinToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(newJoinToken()).not.toBe(a);
  });

  test("the cookie is HttpOnly, Lax, site-wide and Secure only over HTTPS", () => {
    expect(joinCookie("t", false)).toBe(`${JOIN_COOKIE}=t; Path=/; HttpOnly; SameSite=Lax; Max-Age=172800`);
    expect(joinCookie("t", true)).toEndWith("; Secure");
  });

  test("only the current session's token lets a phone in", () => {
    const token = newJoinToken();
    expect(hasJoined(withCookie(`other=1; ${JOIN_COOKIE}=${token}`), token)).toBe(true);
    expect(hasJoined(withCookie(`${JOIN_COOKIE}=${newJoinToken()}`), token)).toBe(false);
    expect(hasJoined(withCookie(), token)).toBe(false);
    expect(hasJoined(withCookie(`${JOIN_COOKIE}=${token}`), null)).toBe(false); // session ended
    expect(tokenMatches(token, token)).toBe(true);
    expect(tokenMatches(token.slice(1), token)).toBe(false);
  });

  test("reads cookies among others", () => {
    expect(readCookie(withCookie("a=1; b=two%20words"), "b")).toBe("two words");
    expect(readCookie(withCookie("a=1"), "b")).toBeNull();
  });

  test("session file round-trips, and old bare-ticket files get a token", () => {
    const ticket = { cfg: newSessionConfig({ epoch: 0 }), peers: [{ id: "abc" }] };
    const stored = { ticket, joinToken: newJoinToken() };
    expect(parseSession(serializeSession(stored))).toEqual(stored);
    const legacy = parseSession(encodeTicket(ticket));
    expect(legacy?.ticket).toEqual(ticket);
    expect(legacy?.joinToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(parseSession("")).toBeNull();
    expect(parseSession("{broken")).toBeNull();
  });
});
