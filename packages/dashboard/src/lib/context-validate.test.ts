import { describe, expect, it, vi } from "vitest";
import { sessionCookieOnly, validateContextChoice } from "./context-validate";

const NAME = "authjs.session-token";
const SECURE_NAME = "__Secure-authjs.session-token";
const opts = (fetchImpl: typeof fetch, over: Record<string, unknown> = {}) => ({
  fetchImpl,
  baseUrl: "http://agent:4000/",
  cookieHeader: `${NAME}=abc`,
  sessionCookieName: NAME,
  secure: false,
  ...over,
});

describe("sessionCookieOnly", () => {
  it("keeps the session cookie in use, with its chunks, and nothing else", () => {
    const header = `theme=dark; ${NAME}.1=part2; other=1; ${NAME}.0=part1; ${NAME}x=nope; ${SECURE_NAME}=forged`;
    expect(sessionCookieOnly(header, NAME)).toBe(`${NAME}.1=part2; ${NAME}.0=part1`);
  });

  it("keeps the whole session cookie when it is not chunked", () => {
    expect(sessionCookieOnly(`a=1; ${SECURE_NAME}=tok; ${NAME}=other`, SECURE_NAME)).toBe(`${SECURE_NAME}=tok`);
  });

  it("is empty when the session cookie in use is absent, even if the other-named one is present", () => {
    expect(sessionCookieOnly(`${NAME}=attacker`, SECURE_NAME)).toBe("");
    expect(sessionCookieOnly("", NAME)).toBe("");
  });
});

describe("validateContextChoice (the agent-server's validate call, made with the requester's own session cookie)", () => {
  it("posts the choice with the session cookie only and is true only for a 200", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const allowed = await validateContextChoice(
      { kind: "tenant", membershipId: "m1" },
      opts(fetchImpl, { cookieHeader: `theme=dark; ${NAME}=abc; ${SECURE_NAME}=zzz; csrf=1` }),
    );

    expect(allowed).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://agent:4000/api/contexts/validate");
    expect(init.method).toBe("POST");
    expect(init.headers.cookie).toBe(`${NAME}=abc`);
    expect(JSON.parse(init.body)).toEqual({ kind: "tenant", membershipId: "m1" });
  });

  it("derives the protocol from the cookie configuration, never from the request", async () => {
    const plain = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    await validateContextChoice({ kind: "personal" }, opts(plain, { secure: false }));
    expect(plain.mock.calls[0]![1].headers["x-forwarded-proto"]).toBeUndefined();

    const secure = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    await validateContextChoice({ kind: "personal" }, opts(secure, { secure: true, sessionCookieName: SECURE_NAME, cookieHeader: `${SECURE_NAME}=abc` }));
    expect(secure.mock.calls[0]![1].headers["x-forwarded-proto"]).toBe("https");
    expect(secure.mock.calls[0]![1].headers.cookie).toBe(`${SECURE_NAME}=abc`);
  });

  it("never sends a service token: the agent-server decides from the person's session alone", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    await validateContextChoice({ kind: "personal" }, opts(fetchImpl));
    expect(fetchImpl.mock.calls[0]![1].headers.authorization).toBeUndefined();
  });

  it.each([
    ["a 403 refusal", () => Promise.resolve(new Response(JSON.stringify({ error: "launch_required" }), { status: 403 }))],
    ["a 401", () => Promise.resolve(new Response("{}", { status: 401 }))],
    ["a server error", () => Promise.resolve(new Response("{}", { status: 500 }))],
    ["a network failure", () => Promise.reject(new TypeError("fetch failed"))],
  ])("is false for %s", async (_name, reply) => {
    expect(await validateContextChoice({ kind: "personal" }, opts(vi.fn(reply)))).toBe(false);
  });

  it("is false, and sends nothing, without the session cookie in use", async () => {
    const fetchImpl = vi.fn();
    expect(await validateContextChoice({ kind: "personal" }, opts(fetchImpl, { cookieHeader: "theme=dark" }))).toBe(false);
    expect(await validateContextChoice({ kind: "personal" }, opts(fetchImpl, { cookieHeader: `${NAME}=attacker`, sessionCookieName: SECURE_NAME, secure: true }))).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
