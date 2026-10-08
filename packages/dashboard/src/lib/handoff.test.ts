import { describe, expect, it, vi } from "vitest";
import { HANDOFF_MESSAGES, redeemHandoff, signOutHandoff } from "./handoff";

const opts = (fetchImpl: typeof fetch) => ({ fetchImpl, baseUrl: "http://agent:4000", token: "svc-token" });
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("hand-off client", () => {
  it("uses the exact user-facing messages", () => {
    expect(HANDOFF_MESSAGES).toEqual({
      expired: "This link has expired. Go back to ImpressoRx and choose Ask Oneon again.",
      membership_suspended: "This pharmacy has switched Oneon off, or your account is inactive.",
      generic: "Oneon couldn't open this link.",
    });
  });

  it("redeems with the service token and returns the identity and membership", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(200, { identityId: "i1", membershipId: "m1" }));

    const result = await redeemHandoff("jws", "sess-1", opts(fetchImpl));

    expect(result).toEqual({ ok: true, identityId: "i1", membershipId: "m1" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://agent:4000/api/auth/handoff/redeem");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer svc-token");
    expect(JSON.parse(init.body)).toEqual({ handoff: "jws", sessionId: "sess-1" });
  });

  it.each(["expired", "generic", "membership_suspended"] as const)("passes the %s reason through", async (reason) => {
    const fetchImpl = vi.fn().mockResolvedValue(json(401, { error: "handoff_rejected", reason }));
    expect(await redeemHandoff("jws", "s", opts(fetchImpl))).toEqual({ ok: false, reason });
  });

  it.each([
    ["an unknown reason", () => json(401, { error: "handoff_rejected", reason: "because" })],
    ["a server error", () => json(500, { error: "boom" })],
    ["a missing token (plain 401)", () => json(401, { error: "Unauthorized" })],
    ["a malformed success body", () => json(200, { identityId: 1 })],
    ["a non-JSON body", () => new Response("<html>", { status: 502 })],
  ])("is generic for %s", async (_name, reply) => {
    const fetchImpl = vi.fn().mockResolvedValue(reply());
    expect(await redeemHandoff("jws", "s", opts(fetchImpl))).toEqual({ ok: false, reason: "generic" });
  });

  it("is generic when the agent-server cannot be reached, or no service token is configured", async () => {
    const down = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    expect(await redeemHandoff("jws", "s", opts(down))).toEqual({ ok: false, reason: "generic" });

    const never = vi.fn();
    expect(await redeemHandoff("jws", "s", { fetchImpl: never, baseUrl: "http://agent:4000", token: undefined })).toEqual({ ok: false, reason: "generic" });
    expect(never).not.toHaveBeenCalled();
  });

  it("sign-out tells the agent-server and never throws", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    await signOutHandoff("sess-1", opts(fetchImpl));
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://agent:4000/api/auth/handoff/sign-out");
    expect(JSON.parse(init.body)).toEqual({ sessionId: "sess-1" });

    await expect(signOutHandoff("sess-1", opts(vi.fn().mockRejectedValue(new Error("down"))))).resolves.toBeUndefined();
  });
});
