import { describe, expect, it, vi } from "vitest";
import { validateContextChoice } from "./context-validate";

const opts = (fetchImpl: typeof fetch, over: Record<string, unknown> = {}) => ({
  fetchImpl,
  baseUrl: "http://agent:4000/",
  cookie: "authjs.session-token=abc",
  ...over,
});

describe("validateContextChoice (the agent-server's validate call, made with the requester's own session cookie)", () => {
  it("posts the choice with the requester's cookie and is true only for a 200", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const allowed = await validateContextChoice({ kind: "tenant", membershipId: "m1" }, opts(fetchImpl, { forwardedProto: "https" }));

    expect(allowed).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://agent:4000/api/contexts/validate");
    expect(init.method).toBe("POST");
    expect(init.headers.cookie).toBe("authjs.session-token=abc");
    expect(init.headers["x-forwarded-proto"]).toBe("https");
    expect(JSON.parse(init.body)).toEqual({ kind: "tenant", membershipId: "m1" });
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

  it("is false without a cookie to forward", async () => {
    const fetchImpl = vi.fn();
    expect(await validateContextChoice({ kind: "personal" }, opts(fetchImpl, { cookie: "" }))).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
