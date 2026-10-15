import { describe, expect, it } from "vitest";
import { LINK_MESSAGES, isLinkReason } from "./link-messages";

describe("link messages", () => {
  it("has a message for each reason and recognises only those", () => {
    for (const reason of Object.keys(LINK_MESSAGES)) {
      expect(isLinkReason(reason)).toBe(true);
      expect(LINK_MESSAGES[reason as keyof typeof LINK_MESSAGES]).toEqual(expect.any(String));
    }
    expect(Object.keys(LINK_MESSAGES).sort()).toEqual(
      ["link_account_disabled", "link_conflict", "link_expired", "link_incomplete", "link_needs_google", "link_outcome_unknown", "link_unavailable"].sort(),
    );
    expect(isLinkReason("generic")).toBe(false);
    expect(isLinkReason(undefined)).toBe(false);
  });

  it("does not say nothing changed when a link may have half happened, and says what is true of each refusal", () => {
    expect(LINK_MESSAGES.link_incomplete).not.toMatch(/nothing (was|has been) changed/i);
    expect(LINK_MESSAGES.link_incomplete).toMatch(/try again/i);
    expect(LINK_MESSAGES.link_outcome_unknown).toMatch(/Settings/);
    expect(LINK_MESSAGES.link_outcome_unknown).toMatch(/try again/i);
    expect(LINK_MESSAGES.link_unavailable).toMatch(/pharmacy/i);
    expect(LINK_MESSAGES.link_unavailable).toMatch(/try again/i);
    // "both have a Google account" is link_conflict's claim and only its.
    expect(LINK_MESSAGES.link_conflict).toMatch(/two Google accounts/i);
    expect(LINK_MESSAGES.link_needs_google).toMatch(/neither/i);
    expect(LINK_MESSAGES.link_needs_google).not.toMatch(/both/i);
  });
});
