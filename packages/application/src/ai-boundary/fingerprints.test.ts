import { describe, it, expect } from "vitest";
import { Fingerprinter } from "./fingerprints.js";

const KEY = "k".repeat(32);

describe("Fingerprinter", () => {
  it("is deterministic per context and differs across contexts", () => {
    const fp = new Fingerprinter(KEY, 1);
    const a = fp.of({ kind: "personal", identityId: "u1" }, "ACCOUNT_472 GHS 18,400");
    expect(a).toBe(fp.of({ kind: "personal", identityId: "u1" }, "ACCOUNT_472 GHS 18,400"));
    expect(a).not.toBe(fp.of({ kind: "personal", identityId: "u2" }, "ACCOUNT_472 GHS 18,400"));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  it("is not a plain SHA-256 of the text (a keyed hash cannot be reversed by guessing)", async () => {
    const { createHash } = await import("node:crypto");
    const fp = new Fingerprinter(KEY, 1);
    expect(fp.of({ kind: "personal", identityId: "u1" }, "x")).not.toBe(createHash("sha256").update("x").digest("hex"));
  });
  it("refuses a master key shorter than 32 characters", () => {
    expect(() => new Fingerprinter("short", 1)).toThrow("at least 32");
  });
});
