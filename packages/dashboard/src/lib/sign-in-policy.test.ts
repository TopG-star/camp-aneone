import { describe, expect, it } from "vitest";
import { isSignInAllowed } from "./sign-in-policy";

const allowed = ["a@x.com"];

describe("isSignInAllowed", () => {
  it("allows a verified, allow-listed email", () => {
    expect(isSignInAllowed({ email: "A@x.com", email_verified: true }, allowed)).toBe(true);
  });
  it("refuses an unverified email even when allow-listed", () => {
    expect(isSignInAllowed({ email: "a@x.com", email_verified: false }, allowed)).toBe(false);
    expect(isSignInAllowed({ email: "a@x.com" }, allowed)).toBe(false);
  });
  it("refuses an email that is not allow-listed or missing", () => {
    expect(isSignInAllowed({ email: "b@x.com", email_verified: true }, allowed)).toBe(false);
    expect(isSignInAllowed({ email_verified: true }, allowed)).toBe(false);
    expect(isSignInAllowed(undefined, allowed)).toBe(false);
  });
});
