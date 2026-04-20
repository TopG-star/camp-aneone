import { describe, it, expect } from "vitest";
import { TokenCipher } from "./token-cipher.js";

describe("TokenCipher", () => {
  const key = "test-encryption-key-must-be-at-least-32-chars-long!!";

  it("encrypts and decrypts a round-trip", () => {
    const cipher = new TokenCipher(key);
    const plaintext = "ya29.a0ARrdaM8_super_secret_access_token";

    const encrypted = cipher.encrypt(plaintext);
    expect(encrypted.ciphertext).not.toBe(plaintext);
    expect(encrypted.iv).toBeTruthy();
    expect(encrypted.tag).toBeTruthy();

    const decrypted = cipher.decrypt(encrypted.ciphertext, encrypted.iv, encrypted.tag);
    expect(decrypted).toBe(plaintext);
  });

  it("produces different ciphertext for same plaintext (unique IV)", () => {
    const cipher = new TokenCipher(key);
    const plaintext = "same-token-value";

    const a = cipher.encrypt(plaintext);
    const b = cipher.encrypt(plaintext);

    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.iv).not.toBe(b.iv);
    expect(a.tag).not.toBe(b.tag);
  });

  it("fails to decrypt with wrong key", () => {
    const cipher1 = new TokenCipher(key);
    const cipher2 = new TokenCipher("different-key-also-must-be-at-least-32-chars!!");

    const encrypted = cipher1.encrypt("secret");

    expect(() =>
      cipher2.decrypt(encrypted.ciphertext, encrypted.iv, encrypted.tag),
    ).toThrow();
  });

  it("fails to decrypt with tampered ciphertext", () => {
    const cipher = new TokenCipher(key);
    const encrypted = cipher.encrypt("secret");

    // Flip a hex character in the ciphertext
    const tampered =
      encrypted.ciphertext.slice(0, 4) +
      (encrypted.ciphertext[4] === "a" ? "b" : "a") +
      encrypted.ciphertext.slice(5);

    expect(() =>
      cipher.decrypt(tampered, encrypted.iv, encrypted.tag),
    ).toThrow();
  });

  it("fails to decrypt with tampered auth tag", () => {
    const cipher = new TokenCipher(key);
    const encrypted = cipher.encrypt("secret");

    const tamperedTag =
      encrypted.tag.slice(0, 2) +
      (encrypted.tag[2] === "f" ? "e" : "f") +
      encrypted.tag.slice(3);

    expect(() =>
      cipher.decrypt(encrypted.ciphertext, encrypted.iv, tamperedTag),
    ).toThrow();
  });

  it("handles empty string", () => {
    const cipher = new TokenCipher(key);
    const encrypted = cipher.encrypt("");
    const decrypted = cipher.decrypt(encrypted.ciphertext, encrypted.iv, encrypted.tag);
    expect(decrypted).toBe("");
  });

  it("handles unicode content", () => {
    const cipher = new TokenCipher(key);
    const plaintext = "tökën-with-ünïcödé-🔐";
    const encrypted = cipher.encrypt(plaintext);
    const decrypted = cipher.decrypt(encrypted.ciphertext, encrypted.iv, encrypted.tag);
    expect(decrypted).toBe(plaintext);
  });

  it("outputs are hex-encoded strings", () => {
    const cipher = new TokenCipher(key);
    const encrypted = cipher.encrypt("test");
    const hexRegex = /^[0-9a-f]+$/;

    expect(encrypted.ciphertext).toMatch(hexRegex);
    expect(encrypted.iv).toMatch(hexRegex);
    expect(encrypted.tag).toMatch(hexRegex);
  });

  it("iv is 24 hex chars (12 bytes)", () => {
    const cipher = new TokenCipher(key);
    const encrypted = cipher.encrypt("test");
    expect(encrypted.iv).toHaveLength(24);
  });

  it("tag is 32 hex chars (16 bytes)", () => {
    const cipher = new TokenCipher(key);
    const encrypted = cipher.encrypt("test");
    expect(encrypted.tag).toHaveLength(32);
  });
});
