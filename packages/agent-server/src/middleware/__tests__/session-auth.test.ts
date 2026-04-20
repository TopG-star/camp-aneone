import { describe, it, expect, vi } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { EncryptJWT } from "jose";
import { subtle } from "node:crypto";
import {
  createSessionAuthMiddleware,
  decryptSessionToken,
} from "../session-auth.js";

const TEST_SECRET = "test-secret-that-is-long-enough-for-auth";

async function deriveKey(secret: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const ikm = await subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HKDF" },
    false,
    ["deriveBits"],
  );
  const bits = await subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: encoder.encode("Auth.js Generated Encryption Key"),
    },
    ikm,
    512,
  );
  return new Uint8Array(bits);
}

async function createSessionJWE(
  payload: Record<string, unknown>,
  secret: string = TEST_SECRET,
): Promise<string> {
  const key = await deriveKey(secret);
  return new EncryptJWT(payload)
    .setProtectedHeader({ alg: "dir", enc: "A256CBC-HS512" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .encrypt(key);
}

describe("Session Auth Middleware", () => {
  describe("decryptSessionToken", () => {
    it("decrypts a valid Auth.js v5 JWE token", async () => {
      const jwe = await createSessionJWE({ email: "Alice@Test.com", name: "Alice" });
      const result = await decryptSessionToken(jwe, TEST_SECRET);

      expect(result).not.toBeNull();
      expect(result!.email).toBe("alice@test.com");
      expect(result!.name).toBe("Alice");
    });

    it("returns null for garbled token", async () => {
      const result = await decryptSessionToken("not.a.valid.jwe.token", TEST_SECRET);
      expect(result).toBeNull();
    });

    it("returns null when token has no email", async () => {
      const jwe = await createSessionJWE({ sub: "123" });
      const result = await decryptSessionToken(jwe, TEST_SECRET);
      expect(result).toBeNull();
    });

    it("returns null for wrong secret", async () => {
      const jwe = await createSessionJWE({ email: "test@test.com" }, TEST_SECRET);
      const result = await decryptSessionToken(jwe, "different-secret-that-is-long-enough");
      expect(result).toBeNull();
    });
  });

  describe("createSessionAuthMiddleware", () => {
    function createApp(
      findUser: (email: string) => { id: string } | null,
      upsertUser?: (user: { id: string; email: string }) => { id: string },
    ) {
      const app = express();
      app.use(cookieParser());
      const sessionAuth = createSessionAuthMiddleware(TEST_SECRET, findUser, upsertUser);
      app.use(sessionAuth);
      app.get("/test", (req, res) => {
        res.json({ userId: req.userId ?? null, userEmail: req.userEmail ?? null });
      });
      return app;
    }

    it("sets req.userId when valid session cookie is present", async () => {
      const jwe = await createSessionJWE({ email: "alice@test.com" });
      const findUser = vi.fn().mockReturnValue({ id: "u1" });
      const app = createApp(findUser);

      const res = await request(app)
        .get("/test")
        .set("Cookie", `authjs.session-token=${jwe}`);

      expect(res.status).toBe(200);
      expect(res.body.userId).toBe("u1");
      expect(res.body.userEmail).toBe("alice@test.com");
      expect(findUser).toHaveBeenCalledWith("alice@test.com");
    });

    it("does not set userId when no cookie", async () => {
      const findUser = vi.fn();
      const app = createApp(findUser);

      const res = await request(app).get("/test");

      expect(res.status).toBe(200);
      expect(res.body.userId).toBeNull();
      expect(findUser).not.toHaveBeenCalled();
    });

    it("does not set userId when user not found in DB", async () => {
      const jwe = await createSessionJWE({ email: "unknown@test.com" });
      const findUser = vi.fn().mockReturnValue(null);
      const app = createApp(findUser);

      const res = await request(app)
        .get("/test")
        .set("Cookie", `authjs.session-token=${jwe}`);

      expect(res.status).toBe(200);
      expect(res.body.userId).toBeNull();
    });

    it("does not set userId for invalid cookie value", async () => {
      const findUser = vi.fn();
      const app = createApp(findUser);

      const res = await request(app)
        .get("/test")
        .set("Cookie", "authjs.session-token=garbage");

      expect(res.status).toBe(200);
      expect(res.body.userId).toBeNull();
    });

    it("auto-creates user via upsertUser when user not found", async () => {
      const jwe = await createSessionJWE({ email: "new-user@test.com" });
      const findUser = vi.fn().mockReturnValue(null);
      const upsertUser = vi.fn().mockReturnValue({ id: "new-uuid" });
      const app = createApp(findUser, upsertUser);

      const res = await request(app)
        .get("/test")
        .set("Cookie", `authjs.session-token=${jwe}`);

      expect(res.status).toBe(200);
      expect(res.body.userId).toBe("new-uuid");
      expect(res.body.userEmail).toBe("new-user@test.com");
      expect(upsertUser).toHaveBeenCalledWith(
        expect.objectContaining({ email: "new-user@test.com" }),
      );
    });

    it("does not auto-create when upsertUser is not provided", async () => {
      const jwe = await createSessionJWE({ email: "unknown@test.com" });
      const findUser = vi.fn().mockReturnValue(null);
      const app = createApp(findUser); // no upsertUser

      const res = await request(app)
        .get("/test")
        .set("Cookie", `authjs.session-token=${jwe}`);

      expect(res.status).toBe(200);
      expect(res.body.userId).toBeNull();
    });
  });
});
