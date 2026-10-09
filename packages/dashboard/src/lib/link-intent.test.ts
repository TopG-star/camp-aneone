import { encode } from "next-auth/jwt";
import { describe, expect, it, vi } from "vitest";
import { completeLink, isSameOrigin, linkCsrfToken, previewLink, readSealedSession, sessionLogin, startLinkIntent } from "./link-intent";

const ID = "6f1c2c4e-7f0e-4c53-9a43-0f7b6c8f1a11";
const SECRET = "A".repeat(43);
const AUTH_SECRET = "a-test-secret-that-is-at-least-32-characters";
const NAME = "authjs.session-token";

// A real sealed session cookie, made the way Auth.js makes it.
async function sealed(token: Record<string, unknown>, name = NAME) {
  return `${name}=${await encode({ token, secret: AUTH_SECRET, salt: name })}`;
}
const reqWith = (cookie: string) => ({ headers: new Headers({ cookie }) });

describe("startLinkIntent (the agent-server call that opens an intent, made with the person's own session cookie)", () => {
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

describe("readSealedSession (what the second sign-in left in the session cookie, read here and never sent to the browser)", () => {
  const env = { AUTH_SECRET };

  it("reads a Google session", async () => {
    const header = await sealed({ sub: "g-sub", email: "a@b.com", provider: "google" });
    expect(await readSealedSession(reqWith(header), env)).toMatchObject({ provider: "google", sub: "g-sub", email: "a@b.com" });
  });

  it("reads a hand-off session with its session id and membership", async () => {
    const header = await sealed({ sub: "identity-1", provider: "impressorx", identityId: "identity-1", sessionId: "s-1", activeContext: { kind: "tenant", membershipId: "m-1" } });
    expect(await readSealedSession(reqWith(header), env)).toMatchObject({ provider: "impressorx", identityId: "identity-1", sessionId: "s-1", membershipId: "m-1" });
  });

  it("treats a token from before `provider` existed as a Google one, and falls back to NEXTAUTH_SECRET", async () => {
    const header = await sealed({ sub: "g-sub", email: "a@b.com" });
    expect(await readSealedSession(reqWith(header), { NEXTAUTH_SECRET: AUTH_SECRET })).toMatchObject({ provider: "google", sub: "g-sub" });
  });

  it("reads the cookie this deployment uses, and nothing else", async () => {
    const header = await sealed({ sub: "g-sub", email: "a@b.com" }, "__Secure-authjs.session-token");
    expect(await readSealedSession(reqWith(header), { ...env, NODE_ENV: "production" })).toMatchObject({ sub: "g-sub" });
    expect(await readSealedSession(reqWith(header), env)).toBeNull();
  });

  it("is nothing without a cookie, with a forged one or without a secret", async () => {
    expect(await readSealedSession(reqWith("theme=dark"), env)).toBeNull();
    expect(await readSealedSession(reqWith(`${NAME}=forged`), env)).toBeNull();
    expect(await readSealedSession(reqWith(await sealed({ sub: "x" })), {})).toBeNull();
  });
});

describe("sessionLogin (who just signed in for the second time)", () => {
  it("is the Google login of a Google session", () => {
    expect(sessionLogin({ provider: "google", sub: "g-sub", email: "a@b.com" })).toEqual({ kind: "google", subject: "g-sub", email: "a@b.com" });
  });

  it("is the hand-off identity of a hand-off session, with the session and membership the agent-server must check", () => {
    expect(sessionLogin({ provider: "impressorx", sub: "identity-1", identityId: "identity-1", sessionId: "s-1", membershipId: "m-1" })).toEqual({
      kind: "impressorx",
      identityId: "identity-1",
      sessionId: "s-1",
      membershipId: "m-1",
    });
  });

  it("is nothing without a session or without what the agent-server needs", () => {
    expect(sessionLogin(null)).toBeNull();
    expect(sessionLogin({ provider: "google", sub: "g-sub" })).toBeNull();
    expect(sessionLogin({ provider: "google", email: "a@b.com" } as never)).toBeNull();
    expect(sessionLogin({ provider: "impressorx", sub: "i", identityId: "i", sessionId: "s" })).toBeNull();
    expect(sessionLogin({ provider: "impressorx", sub: "i", identityId: "i", membershipId: "m" })).toBeNull();
  });
});

describe("linkCsrfToken (the confirm form's token)", () => {
  it("is tied to the intent's secret: only the browser holding the cookie can know it", () => {
    const token = linkCsrfToken({ linkIntentId: ID, secret: SECRET });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(linkCsrfToken({ linkIntentId: ID, secret: SECRET })).toBe(token);
    expect(linkCsrfToken({ linkIntentId: ID, secret: "B".repeat(43) })).not.toBe(token);
    expect(linkCsrfToken({ linkIntentId: "7f1c2c4e-7f0e-4c53-9a43-0f7b6c8f1a11", secret: SECRET })).not.toBe(token);
    expect(token).not.toContain(SECRET);
  });
});

describe("isSameOrigin (only the dashboard's own pages may commit)", () => {
  const post = (headers: Record<string, string>, url = "https://oneon.example/auth/link/confirm") => new Request(url, { method: "POST", headers });

  it("accepts the dashboard's own origin and refuses another origin, 'null' and none", () => {
    expect(isSameOrigin(post({ origin: "https://oneon.example" }), {})).toBe(true);
    expect(isSameOrigin(post({ origin: "https://evil.example" }), {})).toBe(false);
    expect(isSameOrigin(post({ origin: "null" }), {})).toBe(false);
    expect(isSameOrigin(post({}), {})).toBe(false);
  });

  it("goes by the public URL when one is configured, and by the forwarded host behind a proxy", () => {
    const internal = "http://localhost:3000/auth/link/confirm";
    expect(isSameOrigin(post({ origin: "https://oneon.example" }, internal), { AUTH_URL: "https://oneon.example" })).toBe(true);
    expect(isSameOrigin(post({ origin: "https://evil.example" }, internal), { AUTH_URL: "https://oneon.example" })).toBe(false);
    expect(isSameOrigin(post({ origin: "https://oneon.example", "x-forwarded-host": "oneon.example", "x-forwarded-proto": "https" }, internal), {})).toBe(true);
    expect(isSameOrigin(post({ origin: "https://evil.example", "x-forwarded-host": "oneon.example", "x-forwarded-proto": "https" }, internal), {})).toBe(false);
  });
});

describe("previewLink and completeLink (the service-token calls)", () => {
  const intent = { linkIntentId: ID, secret: SECRET };
  const login = { kind: "google" as const, subject: "g-sub", email: "a@b.com" };
  const opts = (fetchImpl: typeof fetch, over: Record<string, unknown> = {}) => ({ fetchImpl, baseUrl: "http://agent:4000/", token: "svc", ...over });
  const answer = (status: number, body: unknown) => vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));

  it("previewLink asks the read-only endpoint with the service token and returns what it says", async () => {
    const fetchImpl = answer(200, { googleEmail: "a@b.com", memberships: [{ role: "Admin", pharmacyName: "Acme" }] });

    expect(await previewLink(intent, login, opts(fetchImpl))).toEqual({ ok: true, googleEmail: "a@b.com", memberships: [{ role: "Admin", pharmacyName: "Acme" }] });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://agent:4000/api/identity/link/preview");
    expect(init.headers.authorization).toBe("Bearer svc");
    expect(JSON.parse(init.body)).toEqual({ linkIntentId: ID, secret: SECRET, login });
  });

  it("previewLink reports a refusal's reason, and anything unexpected as link_incomplete", async () => {
    expect(await previewLink(intent, login, opts(answer(409, { error: "link_unavailable" })))).toEqual({ ok: false, reason: "link_unavailable" });
    expect(await previewLink(intent, login, opts(answer(502, {})))).toEqual({ ok: false, reason: "link_incomplete" });
    expect(await previewLink(intent, login, opts(answer(200, { nope: 1 })))).toEqual({ ok: false, reason: "link_incomplete" });
    expect(await previewLink(intent, login, opts(vi.fn().mockRejectedValue(new Error("down"))))).toEqual({ ok: false, reason: "link_incomplete" });
  });

  it("completeLink posts the intent, its secret and the second login with the service token", async () => {
    const fetchImpl = answer(200, { linked: true, merged: true, identityId: "i" });

    expect(await completeLink(intent, login, opts(fetchImpl))).toEqual({ ok: true });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://agent:4000/api/identity/link");
    expect(init.headers.authorization).toBe("Bearer svc");
    expect(JSON.parse(init.body)).toEqual({ linkIntentId: ID, secret: SECRET, login });
  });

  it.each([
    [409, "link_expired"],
    [409, "link_conflict"],
    [409, "link_needs_google"],
    [409, "link_account_disabled"],
    [409, "link_unavailable"],
    [500, "link_incomplete"],
  ])("completeLink reports the agent-server's %s %s as that reason", async (status, error) => {
    expect(await completeLink(intent, login, opts(answer(status, { error })))).toEqual({ ok: false, reason: error });
  });

  it("completeLink calls a timeout, a network error or an unreadable answer link_outcome_unknown: the merge may have committed", async () => {
    expect(await completeLink(intent, login, opts(vi.fn().mockRejectedValue(new Error("timeout"))))).toEqual({ ok: false, reason: "link_outcome_unknown" });
    expect(await completeLink(intent, login, opts(answer(502, { error: "bad gateway" })))).toEqual({ ok: false, reason: "link_outcome_unknown" });
    expect(await completeLink(intent, login, opts(vi.fn().mockResolvedValue(new Response("<html>504</html>", { status: 504 }))))).toEqual({ ok: false, reason: "link_outcome_unknown" });
  });

  it("completeLink without a service token sends nothing and says the link did not finish", async () => {
    const unused = vi.fn();
    expect(await completeLink(intent, login, opts(unused, { token: undefined }))).toEqual({ ok: false, reason: "link_incomplete" });
    expect(unused).not.toHaveBeenCalled();
  });
});
