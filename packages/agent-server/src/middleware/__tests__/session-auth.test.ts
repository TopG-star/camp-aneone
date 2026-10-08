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
const TEST_COOKIE_SALT = "authjs.session-token";

async function deriveKey(
  secret: string,
  salt: string = TEST_COOKIE_SALT,
): Promise<Uint8Array> {
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
      salt: encoder.encode(salt),
      info: encoder.encode(`Auth.js Generated Encryption Key (${salt})`),
    },
    ikm,
    512,
  );
  return new Uint8Array(bits);
}

async function createSessionJWE(
  payload: Record<string, unknown>,
  secret: string = TEST_SECRET,
  salt: string = TEST_COOKIE_SALT,
): Promise<string> {
  const key = await deriveKey(secret, salt);
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
      const result = await decryptSessionToken(jwe, TEST_SECRET, TEST_COOKIE_SALT);

      expect(result).not.toBeNull();
      expect(result!.email).toBe("alice@test.com");
      expect(result!.name).toBe("Alice");
    });

    it("returns null for garbled token", async () => {
      const result = await decryptSessionToken("not.a.valid.jwe.token", TEST_SECRET, TEST_COOKIE_SALT);
      expect(result).toBeNull();
    });

    it("returns null when token has no email", async () => {
      const jwe = await createSessionJWE({ sub: "123" });
      const result = await decryptSessionToken(jwe, TEST_SECRET, TEST_COOKIE_SALT);
      expect(result).toBeNull();
    });

    it("returns null for wrong secret", async () => {
      const jwe = await createSessionJWE({ email: "test@test.com" }, TEST_SECRET);
      const result = await decryptSessionToken(
        jwe,
        "different-secret-that-is-long-enough",
        TEST_COOKIE_SALT,
      );
      expect(result).toBeNull();
    });

    it("returns null for wrong salt", async () => {
      const jwe = await createSessionJWE({ email: "test@test.com" }, TEST_SECRET, TEST_COOKIE_SALT);
      const result = await decryptSessionToken(
        jwe,
        TEST_SECRET,
        "__Secure-authjs.session-token",
      );
      expect(result).toBeNull();
    });
  });

  describe("createSessionAuthMiddleware", () => {
    type Identity = { id: string; status: "active" | "disabled" };
    type Kind = "google" | "impressorx";

    function fakeIdentities(over: {
      findByLogin?: (kind: Kind, subject: string) => Identity | null;
      attachGoogleSubByEmailOnce?: (email: string, sub: string) => Identity | null;
      createWithLogin?: (input: { kind: Kind; subject: string; email?: string; id?: string }) => Identity;
    } = {}) {
      return {
        findByLogin: vi.fn(over.findByLogin ?? (() => null)),
        attachGoogleSubByEmailOnce: vi.fn(over.attachGoogleSubByEmailOnce ?? (() => null)),
        createWithLogin: vi.fn(
          over.createWithLogin ?? ((input) => ({ id: input.id ?? "generated", status: "active" as const })),
        ),
      };
    }

    function createApp(
      identities: ReturnType<typeof fakeIdentities>,
      upsertUser?: (user: { id: string; email: string }) => { id: string },
    ) {
      const app = express();
      app.use(cookieParser());
      app.use(createSessionAuthMiddleware(TEST_SECRET, identities, upsertUser));
      app.get("/test", (req, res) => {
        res.json({
          userId: req.userId ?? null,
          identityId: req.identityId ?? null,
          userEmail: req.userEmail ?? null,
        });
      });
      return app;
    }

    const cookie = (jwe: string) => `authjs.session-token=${jwe}`;

    it("resolves the identity by sub", async () => {
      const jwe = await createSessionJWE({ email: "alice@test.com", sub: "g-1" });
      const identities = fakeIdentities({ findByLogin: () => ({ id: "u1", status: "active" }) });

      const res = await request(createApp(identities)).get("/test").set("Cookie", cookie(jwe));

      expect(res.body).toEqual({ userId: "u1", identityId: "u1", userEmail: "alice@test.com" });
      expect(identities.findByLogin).toHaveBeenCalledWith("google", "g-1");
      expect(identities.attachGoogleSubByEmailOnce).not.toHaveBeenCalled();
    });

    it("migrates a pre-existing user on first sign-in with sub", async () => {
      const jwe = await createSessionJWE({ email: "alice@test.com", sub: "g-1" });
      const identities = fakeIdentities({ attachGoogleSubByEmailOnce: () => ({ id: "users-id", status: "active" }) });

      const res = await request(createApp(identities)).get("/test").set("Cookie", cookie(jwe));

      expect(res.body.identityId).toBe("users-id");
      expect(res.body.userId).toBe("users-id");
      expect(identities.attachGoogleSubByEmailOnce).toHaveBeenCalledWith("alice@test.com", "g-1");
    });

    it("a session without sub is treated as signed out", async () => {
      const jwe = await createSessionJWE({ email: "alice@test.com" });
      const identities = fakeIdentities({ findByLogin: () => ({ id: "u1", status: "active" }) });
      const upsertUser = vi.fn();

      const res = await request(createApp(identities, upsertUser)).get("/test").set("Cookie", cookie(jwe));

      expect(res.body).toEqual({ userId: null, identityId: null, userEmail: null });
      expect(identities.findByLogin).not.toHaveBeenCalled();
      expect(identities.attachGoogleSubByEmailOnce).not.toHaveBeenCalled();
      expect(upsertUser).not.toHaveBeenCalled();
    });

    it("creates an identity and a users row with the same id for a new user", async () => {
      const jwe = await createSessionJWE({ email: "new@test.com", sub: "g-new" });
      const identities = fakeIdentities();
      const upsertUser = vi.fn((user: { id: string; email: string }) => ({ id: user.id }));

      const res = await request(createApp(identities, upsertUser)).get("/test").set("Cookie", cookie(jwe));

      const created = identities.createWithLogin.mock.calls[0]![0];
      expect(created).toMatchObject({ kind: "google", subject: "g-new", email: "new@test.com" });
      expect(upsertUser).toHaveBeenCalledWith({ id: created.id, email: "new@test.com" });
      expect(res.body.identityId).toBe(created.id);
      expect(res.body.userId).toBe(created.id);
    });

    it("does not auto-create when upsertUser is not provided", async () => {
      const jwe = await createSessionJWE({ email: "unknown@test.com", sub: "g-x" });
      const identities = fakeIdentities();

      const res = await request(createApp(identities)).get("/test").set("Cookie", cookie(jwe));

      expect(res.body.userId).toBeNull();
      expect(identities.createWithLogin).not.toHaveBeenCalled();
    });

    it("treats a disabled identity as signed out", async () => {
      const jwe = await createSessionJWE({ email: "alice@test.com", sub: "g-1" });
      const identities = fakeIdentities({ findByLogin: () => ({ id: "u1", status: "disabled" }) });

      const res = await request(createApp(identities)).get("/test").set("Cookie", cookie(jwe));

      expect(res.body.identityId).toBeNull();
    });

    it("recovers when a concurrent request created the identity first", async () => {
      const jwe = await createSessionJWE({ email: "race@test.com", sub: "g-race" });
      const lookups: Array<Identity | null> = [null, { id: "winner", status: "active" }];
      const identities = fakeIdentities({
        findByLogin: () => lookups.shift() ?? null,
        createWithLogin: () => {
          throw Object.assign(new Error("UNIQUE constraint failed"), { code: "SQLITE_CONSTRAINT_UNIQUE" });
        },
      });

      const res = await request(createApp(identities, (user) => ({ id: user.id })))
        .get("/test")
        .set("Cookie", cookie(jwe));

      expect(res.body.identityId).toBe("winner");
    });

    it("logs other creation errors without token material and treats the session as signed out", async () => {
      const jwe = await createSessionJWE({ email: "boom@test.com", sub: "g-boom" });
      const identities = fakeIdentities({
        createWithLogin: () => {
          throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
        },
      });
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
      const app = express();
      app.use(cookieParser());
      app.use(createSessionAuthMiddleware(TEST_SECRET, identities, (user) => ({ id: user.id }), logger));
      app.get("/test", (req, res) => res.json({ identityId: req.identityId ?? null }));

      const res = await request(app).get("/test").set("Cookie", cookie(jwe));

      expect(res.body.identityId).toBeNull();
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(jwe);
    });

    it("reads a session token split into cookie chunks", async () => {
      const jwe = await createSessionJWE({ email: "chunked@test.com", sub: "g-chunk" });
      const chunkSize = Math.ceil(jwe.length / 3);
      const identities = fakeIdentities({ findByLogin: () => ({ id: "u-chunk", status: "active" }) });

      const res = await request(createApp(identities))
        .get("/test")
        .set("Cookie", [
          `authjs.session-token.0=${jwe.slice(0, chunkSize)}`,
          `authjs.session-token.1=${jwe.slice(chunkSize, chunkSize * 2)}`,
          `authjs.session-token.2=${jwe.slice(chunkSize * 2)}`,
        ]);

      expect(res.body.userId).toBe("u-chunk");
    });

    it("does nothing when there is no cookie or the cookie is garbage", async () => {
      const identities = fakeIdentities();
      const app = createApp(identities);

      const none = await request(app).get("/test");
      const garbage = await request(app).get("/test").set("Cookie", "authjs.session-token=garbage");

      expect(none.body.userId).toBeNull();
      expect(garbage.body.userId).toBeNull();
      expect(identities.findByLogin).not.toHaveBeenCalled();
    });

    describe("hand-off sessions (provider impressorx)", () => {
      const base = {
        provider: "impressorx",
        identityId: "irx-id",
        sessionId: "sess-1",
        activeContext: { kind: "tenant", membershipId: "m1" },
      };
      const activeMembership = { id: "m1", identityId: "irx-id", status: "active" as const };

      function handoffApp(
        identities: ReturnType<typeof fakeIdentities>,
        checks: ReturnType<typeof deps> | undefined,
        upsertUser?: (user: { id: string; email: string }) => { id: string },
      ) {
        const app = express();
        app.use(cookieParser());
        app.use(
          createSessionAuthMiddleware(
            TEST_SECRET,
            identities,
            upsertUser,
            undefined,
            checks && { memberships: checks.memberships, identities: { findById: checks.findIdentity }, hasActiveSession: checks.hasActiveSession },
          ),
        );
        app.get("/test", (req, res) =>
          res.json({
            userId: req.userId ?? null,
            identityId: req.identityId ?? null,
            sessionId: req.sessionId ?? null,
            activeContext: req.activeContext ?? null,
            userEmail: req.userEmail ?? null,
          }),
        );
        return app;
      }
      const deps = (over: { membership?: unknown; sessionActive?: boolean; identity?: Identity | null } = {}) => ({
        memberships: { findById: vi.fn(() => ("membership" in over ? over.membership : activeMembership) as never) },
        findIdentity: vi.fn(() => ("identity" in over ? over.identity! : { id: "irx-id", status: "active" as const })),
        hasActiveSession: vi.fn(() => over.sessionActive ?? true),
      });

      it("resolves by identityId, carries the session and context, and never looks up a Google sub", async () => {
        const jwe = await createSessionJWE({ ...base, sub: "irx-id" });
        const identities = fakeIdentities({ findByLogin: () => ({ id: "someone-else", status: "active" }) });
        const upsertUser = vi.fn();

        const res = await request(handoffApp(identities, deps(), upsertUser)).get("/test").set("Cookie", cookie(jwe));

        expect(res.body).toEqual({
          userId: "irx-id",
          identityId: "irx-id",
          sessionId: "sess-1",
          activeContext: { kind: "tenant", membershipId: "m1" },
          userEmail: null,
        });
        expect(identities.findByLogin).not.toHaveBeenCalled();
        expect(identities.attachGoogleSubByEmailOnce).not.toHaveBeenCalled();
        expect(identities.createWithLogin).not.toHaveBeenCalled();
        expect(upsertUser).not.toHaveBeenCalled();
      });

      it("is never resolved as a Google sub even when the token carries an email and a sub", async () => {
        const jwe = await createSessionJWE({ ...base, email: "x@y.com", sub: "g-1", identityId: undefined });
        const identities = fakeIdentities({ findByLogin: () => ({ id: "u1", status: "active" }) });

        const res = await request(handoffApp(identities, deps())).get("/test").set("Cookie", cookie(jwe));

        expect(res.body.identityId).toBeNull();
        expect(identities.findByLogin).not.toHaveBeenCalled();
      });

      it.each([
        ["the membership is not active", { membership: { ...activeMembership, status: "suspended" } }],
        ["the membership is unknown", { membership: null }],
        ["the membership belongs to another identity", { membership: { ...activeMembership, identityId: "other" } }],
        ["the identity is disabled", { identity: { id: "irx-id", status: "disabled" as const } }],
        ["the attended grant is gone (signed out, revoked, expired)", { sessionActive: false }],
      ])("is signed out when %s", async (_name, over) => {
        const jwe = await createSessionJWE(base);
        const res = await request(handoffApp(fakeIdentities(), deps(over))).get("/test").set("Cookie", cookie(jwe));
        expect(res.body.identityId).toBeNull();
        expect(res.body.sessionId).toBeNull();
      });

      it.each([
        ["no sessionId", { sessionId: undefined }],
        ["no identityId", { identityId: undefined }],
        ["no active context", { activeContext: undefined }],
        ["a context of another kind", { activeContext: { kind: "personal" } }],
      ])("is signed out with %s", async (_name, over) => {
        const jwe = await createSessionJWE({ ...base, ...over });
        const res = await request(handoffApp(fakeIdentities(), deps())).get("/test").set("Cookie", cookie(jwe));
        expect(res.body.identityId).toBeNull();
      });

      it("is signed out when hand-off support is not configured", async () => {
        const jwe = await createSessionJWE(base);
        const res = await request(handoffApp(fakeIdentities(), undefined)).get("/test").set("Cookie", cookie(jwe));
        expect(res.body.identityId).toBeNull();
      });

      it("treats an unknown provider as signed out", async () => {
        const jwe = await createSessionJWE({ ...base, provider: "github", email: "a@b.com", sub: "s" });
        const identities = fakeIdentities({ findByLogin: () => ({ id: "u1", status: "active" }) });
        const res = await request(handoffApp(identities, deps())).get("/test").set("Cookie", cookie(jwe));
        expect(res.body.identityId).toBeNull();
        expect(identities.findByLogin).not.toHaveBeenCalled();
      });

      it("a Google session ignores any hand-off fields it carries", async () => {
        const jwe = await createSessionJWE({ provider: "google", email: "a@b.com", sub: "g-1", identityId: "irx-id", sessionId: "s", activeContext: base.activeContext });
        const identities = fakeIdentities({ findByLogin: () => ({ id: "u1", status: "active" }) });
        const res = await request(handoffApp(identities, deps())).get("/test").set("Cookie", cookie(jwe));
        expect(res.body).toMatchObject({ identityId: "u1", sessionId: null, activeContext: null });
        expect(identities.findByLogin).toHaveBeenCalledWith("google", "g-1");
      });
    });

    it("reads the secure session cookie when x-forwarded-proto contains https in a list", async () => {
      const jwe = await createSessionJWE(
        { email: "secure-list@test.com", sub: "g-secure" },
        TEST_SECRET,
        "__Secure-authjs.session-token",
      );
      const identities = fakeIdentities({ findByLogin: () => ({ id: "u-secure", status: "active" }) });

      const res = await request(createApp(identities))
        .get("/test")
        .set("x-forwarded-proto", "https,http")
        .set("Cookie", `__Secure-authjs.session-token=${jwe}`);

      expect(res.body.userId).toBe("u-secure");
      expect(res.body.userEmail).toBe("secure-list@test.com");
    });
  });
});
