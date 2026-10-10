import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openBuffer, openSecret, sealBuffer, sealSecret } from "./envelope.js";

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

describe("sealBuffer / openBuffer", () => {
  it("round-trips raw bytes and never repeats a ciphertext", () => {
    const key = master();
    const bytes = randomBytes(5000);
    const a = sealBuffer(bytes, key, "2026-10-10/personal.db.enc");
    const b = sealBuffer(bytes, key, "2026-10-10/personal.db.enc");
    expect(openBuffer(a, key, "2026-10-10/personal.db.enc").equals(bytes)).toBe(true);
    expect(a.equals(b)).toBe(false);
    expect(a.includes(bytes.subarray(0, 64))).toBe(false);
  });

  it("refuses the wrong key, the wrong associated data and a changed byte", () => {
    const key = master();
    const sealed = sealBuffer(Buffer.from("a database"), key, "2026-10-10/a.db.enc");
    expect(() => openBuffer(sealed, master(), "2026-10-10/a.db.enc")).toThrow();
    expect(() => openBuffer(sealed, key, "2026-10-10/b.db.enc")).toThrow();
    const flipped = Buffer.from(sealed);
    flipped[flipped.length - 1] ^= 1;
    expect(() => openBuffer(flipped, key, "2026-10-10/a.db.enc")).toThrow();
    expect(() => openBuffer(Buffer.alloc(5), key, "x")).toThrow();
  });

  it("refuses a key that is not 32 bytes", () => {
    expect(() => sealBuffer(Buffer.from("x"), Buffer.alloc(16).toString("base64"), "x")).toThrow();
  });
});
