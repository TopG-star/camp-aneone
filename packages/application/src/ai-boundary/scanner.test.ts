import { describe, it, expect } from "vitest";
import { REMOVED_MARKER, removeSpans, scanText } from "./scanner.js";

describe("scanText: D4 (deny the call)", () => {
  it.each([
    ["an Anthropic-style key", "use sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123 please", "api_key"],
    ["a GitHub token", "token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB", "github_token"],
    ["an AWS key id", "AKIAABCDEFGHIJKLMNOP", "aws_key"],
    ["a private key block", "-----BEGIN RSA PRIVATE KEY-----", "private_key"],
    ["a JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "jwt"],
    ["a valid card number", "card 4111 1111 1111 1111 exp 12/29", "card_number"],
    ["a Ghana Card number", "my ID is GHA-123456789-0", "national_id"],
    ["a password assignment", "password: hunter2!", "password"],
  ])("flags %s", (_label, text, kind) => {
    expect(scanText(text).d4).toContain(kind);
  });

  it("does not flag a 16-digit number that fails the Luhn check", () => {
    expect(scanText("order 1234 5678 9012 3456").d4).not.toContain("card_number");
  });

  it("returns pattern names only, never the matched text", () => {
    expect(JSON.stringify(scanText("password: hunter2!"))).not.toContain("hunter2");
  });
});

describe("scanText: D3 (remove the span)", () => {
  it("finds health-linked phrases", () => {
    const text = "Kojo was diagnosed with hepatitis B last year. Meeting at 3.";
    const { d3Spans } = scanText(text);
    expect(d3Spans.length).toBeGreaterThan(0);
    expect(removeSpans(text, d3Spans)).toContain(REMOVED_MARKER);
    expect(removeSpans(text, d3Spans)).not.toMatch(/hepatitis/i);
    expect(removeSpans(text, d3Spans)).toContain("Meeting at 3.");
  });

  it("leaves ordinary business text alone", () => {
    expect(scanText("We sold 500 packs of amoxicillin in September.").d3Spans).toEqual([]);
  });

  it("merges overlapping spans before removing them", () => {
    const text = "diagnosed with HIV";
    expect(removeSpans(text, scanText(text).d3Spans)).toBe(REMOVED_MARKER);
  });
});
