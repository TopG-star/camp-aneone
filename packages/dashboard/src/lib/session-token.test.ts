import { describe, expect, it, vi } from "vitest";
import { applyContextUpdate, applySignIn } from "./session-token";

describe("session token on sign-in", () => {
  it("records a hand-off session by identity, session and active context, and keeps nothing else", () => {
    const previous = { sub: "g-1", email: "someone@else.com", name: "Someone", picture: "p", provider: "google" };

    const token = applySignIn(previous, {
      account: { provider: "impressorx" },
      user: { id: "irx-id", identityId: "irx-id", membershipId: "m1", sessionId: "sess-1" },
    });

    expect(token).toEqual({
      sub: "irx-id",
      provider: "impressorx",
      identityId: "irx-id",
      sessionId: "sess-1",
      activeContext: { kind: "tenant", membershipId: "m1" },
    });
  });

  it("records a Google session by provider, lower-cased email and Google sub", () => {
    const token = applySignIn(
      { sub: "x" },
      { account: { provider: "google" }, profile: { email: "Alice@Test.com", sub: "g-1" } },
    );
    expect(token).toEqual({ sub: "g-1", email: "alice@test.com", provider: "google" });
  });

  it("leaves a token alone when there is no sign-in (a later session read)", () => {
    const token = { sub: "irx-id", provider: "impressorx", identityId: "irx-id" };
    expect(applySignIn(token, {})).toBe(token);
  });

  it("does not build a hand-off session from an incomplete user", () => {
    expect(() => applySignIn({}, { account: { provider: "impressorx" }, user: { id: "x" } })).toThrow();
  });
});

describe("session token on update (the context picker)", () => {
  const google = { sub: "g-1", email: "a@b.com", provider: "google" };

  it("never stores a requested context the agent-server has not validated", async () => {
    const validate = vi.fn().mockResolvedValue(false);

    const token = await applyContextUpdate({ ...google }, { kind: "tenant", membershipId: "m1" }, validate);

    expect(validate).toHaveBeenCalledWith({ kind: "tenant", membershipId: "m1" });
    expect(token).toEqual(google);
  });

  it("stores a validated context, and only the fields the validate call saw", async () => {
    const validate = vi.fn().mockResolvedValue(true);

    const token = await applyContextUpdate({ ...google }, { kind: "tenant", membershipId: "m1", tenantId: "smuggled", role: "Admin" }, validate);

    expect(validate).toHaveBeenCalledWith({ kind: "tenant", membershipId: "m1" });
    expect(token).toEqual({ ...google, activeContext: { kind: "tenant", membershipId: "m1" } });
  });

  it("stores a validated personal context for a Google session", async () => {
    const token = await applyContextUpdate({ ...google, activeContext: { kind: "tenant", membershipId: "m1" } }, { kind: "personal" }, async () => true);
    expect(token).toEqual({ ...google, activeContext: { kind: "personal" } });
  });

  it("keeps a hand-off token's identity and session whatever is requested", async () => {
    const handoff = { sub: "i", provider: "impressorx", identityId: "i", sessionId: "s", activeContext: { kind: "tenant", membershipId: "m1" } };

    expect(await applyContextUpdate({ ...handoff }, { kind: "personal" }, async () => false)).toEqual(handoff);
    expect(await applyContextUpdate({ ...handoff }, { kind: "tenant", membershipId: "m1" }, async () => true)).toEqual(handoff);
  });

  it.each([undefined, null, "tenant", { kind: "tenant" }, { kind: "bogus" }])("ignores a malformed request %j without asking the agent-server", async (requested) => {
    const validate = vi.fn();
    expect(await applyContextUpdate({ ...google }, requested, validate)).toEqual(google);
    expect(validate).not.toHaveBeenCalled();
  });

  it("keeps the current context when validation fails to run", async () => {
    const token = await applyContextUpdate({ ...google }, { kind: "personal" }, async () => {
      throw new Error("boom");
    });
    expect(token).toEqual(google);
  });
});
