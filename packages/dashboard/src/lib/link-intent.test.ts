import { describe, expect, it, vi } from "vitest";
import {
  LINK_MESSAGES,
  completeLink,
  isLinkReason,
  linkCookie,
  readLinkIntent,
  serializeLinkIntent,
  sessionLogin,
  startLinkIntent,
} from "./link-intent";

const ID = "6f1c2c4e-7f0e-4c53-9a43-0f7b6c8f1a11";
const SECRET = "A".repeat(43);

describe("link intent cookie", () => {
  it("is HttpOnly, SameSite=Lax, limited to the link pages, lives 5 minutes and is Secure over https and in production", () => {
    for (const env of [{ AUTH_URL: "https://oneon.example" }, { NEXTAUTH_URL: "https://oneon.example" }, { NODE_ENV: "production" }]) {
      const cookie = linkCookie(env);
      expect(cookie.name).toBe("__Secure-oneon-link-intent");
      expect(cookie.options).toEqual({ httpOnly: true, sameSite: "lax", secure: true, path: "/auth/link", maxAge: 300 });
    }
  });

  it("is not Secure only for plain-http development", () => {
    const cookie = linkCookie({ NODE_ENV: "development", AUTH_URL: "http://localhost:3000" });
    expect(cookie.name).toBe("oneon-link-intent");
    expect(cookie.options).toMatchObject({ httpOnly: true, sameSite: "lax", secure: false, maxAge: 300 });
  });

  it("round-trips the id and secret and ignores every other cookie", () => {
    const value = serializeLinkIntent({ linkIntentId: ID, secret: SECRET });
    expect(readLinkIntent(`theme=dark; oneon-link-intent=${value}; x=1`, "oneon-link-intent")).toEqual({ linkIntentId: ID, secret: SECRET });
    expect(readLinkIntent(`__Secure-oneon-link-intent=${value}`, "oneon-link-intent")).toBeNull();
    expect(readLinkIntent("", "oneon-link-intent")).toBeNull();
  });

  it("rejects a malformed value", () => {
    for (const bad of ["", "nodot", `${ID}.`, `.${SECRET}`, `${ID}.${SECRET}.extra`, `not an id.${SECRET}`, `${ID}.short`]) {
      expect(readLinkIntent(`oneon-link-intent=${bad}`, "oneon-link-intent")).toBeNull();
    }
  });
});

describe("startLinkIntent (the agent-server call that opens an intent, made with the person's own session cookie)", () => {
  const NAME = "authjs.session-token";
  const opts = (fetchImpl: typeof fetch, over: Record<string, unknown> = {}) => ({
    fetchImpl,
    baseUrl: "http://agent:4000/",
    cookieHeader: `theme=dark; ${NAME}=abc; other=1`,
    sessionCookieName: NAME,
    secure: false,
    ...over,
  });

  it("replays only the session cookie, sends no service token, and returns the intent with the next step", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ linkIntentId: ID, secret: SECRET, next: "google" }), { status: 200 }));

    const result = await startLinkIntent(opts(fetchImpl));

    expect(result).toEqual({ ok: true, intent: { linkIntentId: ID, secret: SECRET }, next: "google" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://agent:4000/api/identity/link-intent");
    expect(init.method).toBe("POST");
    expect(init.headers.cookie).toBe(`${NAME}=abc`);
    expect(init.headers.authorization).toBeUndefined();
  });

  it("tells the agent-server which protocol the cookie was set under", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ linkIntentId: ID, secret: SECRET, next: "handoff" }), { status: 200 }));
    await startLinkIntent(opts(fetchImpl, { secure: true, sessionCookieName: `__Secure-${NAME}`, cookieHeader: `__Secure-${NAME}=abc` }));
    expect(fetchImpl.mock.calls[0]![1].headers["x-forwarded-proto"]).toBe("https");
  });

  it("fails with the agent-server's status for a refusal, 502 when it cannot be reached or answers nonsense, and without a session cookie sends nothing", async () => {
    expect(await startLinkIntent(opts(vi.fn().mockResolvedValue(new Response("{}", { status: 401 }))))).toEqual({ ok: false, status: 401 });
    expect(await startLinkIntent(opts(vi.fn().mockRejectedValue(new Error("down"))))).toEqual({ ok: false, status: 502 });
    expect(await startLinkIntent(opts(vi.fn().mockResolvedValue(new Response(JSON.stringify({ next: "other" }), { status: 200 }))))).toEqual({ ok: false, status: 502 });
    const unused = vi.fn();
    expect(await startLinkIntent(opts(unused, { cookieHeader: "theme=dark" }))).toEqual({ ok: false, status: 401 });
    expect(unused).not.toHaveBeenCalled();
  });
});

describe("sessionLogin (who just signed in for the second time)", () => {
  it("is the Google login of a Google session", () => {
    expect(sessionLogin({ provider: "google", user: { sub: "g-sub", email: "a@b.com" } })).toEqual({ kind: "google", subject: "g-sub", email: "a@b.com" });
    // A session from before `provider` existed is a Google one.
    expect(sessionLogin({ user: { sub: "g-sub", email: "a@b.com" } })).toEqual({ kind: "google", subject: "g-sub", email: "a@b.com" });
  });

  it("is the hand-off identity of a hand-off session (its token subject is the identity id)", () => {
    expect(sessionLogin({ provider: "impressorx", user: { sub: "identity-1" } })).toEqual({ kind: "impressorx", identityId: "identity-1" });
  });

  it("is nothing without a session or without what the agent-server needs", () => {
    expect(sessionLogin(null)).toBeNull();
    expect(sessionLogin({ provider: "google", user: { sub: "g-sub" } })).toBeNull();
    expect(sessionLogin({ provider: "google", user: { email: "a@b.com" } })).toBeNull();
    expect(sessionLogin({ provider: "impressorx", user: {} })).toBeNull();
  });
});

describe("completeLink (the service-token call that finishes a link)", () => {
  const intent = { linkIntentId: ID, secret: SECRET };
  const login = { kind: "google" as const, subject: "g-sub", email: "a@b.com" };
  const opts = (fetchImpl: typeof fetch, over: Record<string, unknown> = {}) => ({ fetchImpl, baseUrl: "http://agent:4000/", token: "svc", ...over });

  it("posts the intent, its secret and the second login with the service token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ linked: true, merged: true, identityId: "i" }), { status: 200 }));

    expect(await completeLink(intent, login, opts(fetchImpl))).toEqual({ ok: true });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://agent:4000/api/identity/link");
    expect(init.headers.authorization).toBe("Bearer svc");
    expect(JSON.parse(init.body)).toEqual({ linkIntentId: ID, secret: SECRET, login });
  });

  it.each(["link_expired", "link_conflict", "link_incomplete"])("reports %s as the reason", async (error) => {
    const status = error === "link_incomplete" ? 500 : 409;
    expect(await completeLink(intent, login, opts(vi.fn().mockResolvedValue(new Response(JSON.stringify({ error }), { status }))))).toEqual({ ok: false, reason: error });
  });

  it("reports anything else, an unreachable agent-server or a missing token as link_incomplete, without calling when there is no token", async () => {
    expect(await completeLink(intent, login, opts(vi.fn().mockResolvedValue(new Response("oops", { status: 502 }))))).toEqual({ ok: false, reason: "link_incomplete" });
    expect(await completeLink(intent, login, opts(vi.fn().mockRejectedValue(new Error("down"))))).toEqual({ ok: false, reason: "link_incomplete" });
    const unused = vi.fn();
    expect(await completeLink(intent, login, opts(unused, { token: undefined }))).toEqual({ ok: false, reason: "link_incomplete" });
    expect(unused).not.toHaveBeenCalled();
  });
});

describe("link messages", () => {
  it("has a message for each reason and recognises only those", () => {
    for (const reason of ["link_expired", "link_conflict", "link_incomplete"]) {
      expect(isLinkReason(reason)).toBe(true);
      expect(LINK_MESSAGES[reason as keyof typeof LINK_MESSAGES]).toEqual(expect.any(String));
    }
    expect(isLinkReason("generic")).toBe(false);
    expect(isLinkReason(undefined)).toBe(false);
  });
});
