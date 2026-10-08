import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openSecret, sealSecret } from "./envelope.js";

const master = () => randomBytes(32).toString("base64");

describe("envelope", () => {
  it("round-trips and uses a different data key per secret", () => {
    const key = master();
    const a = sealSecret("private-key-material", key);
    const b = sealSecret("private-key-material", key);
    expect(openSecret(a, key)).toBe("private-key-material");
    expect(openSecret(b, key)).toBe("private-key-material");
    expect(a.wrappedKey).not.toBe(b.wrappedKey);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.ciphertext).not.toContain("private-key-material");
  });

  it("openSecret fails with the wrong master key", () => {
    const sealed = sealSecret("secret", master());
    expect(() => openSecret(sealed, master())).toThrow();
  });

  it("refuses a master key that is not 32 bytes", () => {
    expect(() => sealSecret("secret", Buffer.alloc(16).toString("base64"))).toThrow();
  });
});
