import { describe, expect, it } from "vitest";
import { applySignIn } from "./session-token";

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
