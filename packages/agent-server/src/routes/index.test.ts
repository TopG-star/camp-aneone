import { describe, it, expect, vi, afterEach } from "vitest";
import { subtle } from "node:crypto";
import cookieParser from "cookie-parser";
import express from "express";
import { EncryptJWT } from "jose";
import request from "supertest";
import { StructuredLogger } from "@oneon/infrastructure";
import { loadEnv } from "../config/env.js";
import { createContainer } from "../container.js";
import { registerRoutes } from "./index.js";

function stubEnv(): void {
  vi.stubEnv("NEXTAUTH_SECRET", "test-secret");
  vi.stubEnv("ALLOWED_EMAILS", "alice@test.com");
  vi.stubEnv("API_TOKEN", "test-api-token");
  vi.stubEnv("OAUTH_TOKEN_ENCRYPTION_KEY", "test-encryption-key-at-least-32-chars");
  vi.stubEnv("GOOGLE_CLIENT_ID", "test-client-id");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-client-secret");
  vi.stubEnv("GOOGLE_REFRESH_TOKEN", "");
  vi.stubEnv("DATABASE_PATH", ":memory:");
  vi.stubEnv("CONTROL_DATABASE_PATH", ":memory:");
  vi.stubEnv("LOG_LEVEL", "error");
  vi.stubEnv("FEATURE_CHAT", "true");
}

/** An Auth.js v5 session cookie for the test secret, as the dashboard would set it. */
async function sessionCookie(payload: Record<string, unknown>): Promise<string> {
  const salt = "authjs.session-token";
  const encoder = new TextEncoder();
  const ikm = await subtle.importKey("raw", encoder.encode("test-secret"), { name: "HKDF" }, false, ["deriveBits"]);
  const bits = await subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode(salt), info: encoder.encode(`Auth.js Generated Encryption Key (${salt})`) },
    ikm,
    512,
  );
  const jwe = await new EncryptJWT(payload).setProtectedHeader({ alg: "dir", enc: "A256CBC-HS512" }).setIssuedAt().setExpirationTime("1h").encrypt(new Uint8Array(bits));
  return `${salt}=${jwe}`;
}

describe("registerRoutes: chat calendar read tools", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("registers list_calendar_events and search_calendar on an OAuth-only deployment (no env-token calendar)", () => {
    stubEnv();
    const container = createContainer(loadEnv());
    try {
      expect(container.calendarPort).toBeNull();
      const info = vi.spyOn(StructuredLogger.prototype, "info");
      registerRoutes(express(), container);
      const registered = info.mock.calls.find(([message]) => message === "Chat route registered at /api/chat");
      expect(registered?.[1]?.tools).toEqual(expect.arrayContaining(["list_calendar_events", "search_calendar"]));
    } finally {
      container.shutdown();
    }
  });

  it("serves hand-off redemption behind the service token only", async () => {
    stubEnv();
    const container = createContainer(loadEnv());
    try {
      const app = express();
      app.use(express.json());
      registerRoutes(app, container);

      const anonymous = await request(app).post("/api/auth/handoff/redeem").send({ handoff: "x", sessionId: "y" });
      const withToken = await request(app)
        .post("/api/auth/handoff/redeem")
        .set("Authorization", "Bearer test-api-token")
        .send({ handoff: "x", sessionId: "y" });

      expect(anonymous.status).toBe(401);
      expect(anonymous.body).toEqual({ error: "Unauthorized" });
      expect(withToken.status).toBe(401);
      expect(withToken.body).toEqual({ error: "handoff_rejected", reason: "generic" });
    } finally {
      container.shutdown();
    }
  });

  it("serves Connections and the login list to a session in a pharmacy context, where a personal-only route refuses it", async () => {
    stubEnv();
    const container = createContainer(loadEnv());
    try {
      const app = express();
      app.use(cookieParser());
      app.use(express.json());
      registerRoutes(app, container);
      // A Google session that has chosen a pharmacy: the same context-bearing session a hand-off gives (sessionAuth sets the context).
      const cookie = await sessionCookie({ email: "alice@test.com", sub: "g-alice", provider: "google", activeContext: { kind: "tenant", membershipId: "m-pharmacy" } });

      const personalOnly = await request(app).get("/api/inbox").set("Cookie", cookie);
      const connections = await request(app).get("/api/connections").set("Cookie", cookie);
      const logins = await request(app).get("/api/identity/logins").set("Cookie", cookie);
      const signedOut = await request(app).get("/api/connections");

      expect(personalOnly.status).toBe(403);
      expect(personalOnly.body).toEqual({ error: "personal_context_required" });
      expect(connections.status).toBe(200);
      expect(connections.body).toEqual({ grants: [], needsReconnect: [], unavailable: [] });
      expect(logins.status).toBe(200);
      expect(logins.body.logins).toEqual([expect.objectContaining({ kind: "google", label: "alice@test.com" })]);
      expect(signedOut.status).toBe(401);
    } finally {
      container.shutdown();
    }
  });

  it("mounts the pharmacy AI limit behind the context chain: a personal session is told it needs a pharmacy, a signed-out request is refused", async () => {
    stubEnv();
    const container = createContainer(loadEnv());
    try {
      const app = express();
      app.use(cookieParser());
      app.use(express.json());
      registerRoutes(app, container);
      const cookie = await sessionCookie({ email: "alice@test.com", sub: "g-alice", provider: "google" });

      const personal = await request(app).get("/api/tenant/ai-limit").set("Cookie", cookie);
      const signedOut = await request(app).get("/api/tenant/ai-limit");

      expect(personal.status).toBe(403);
      expect(personal.body).toEqual({ error: "tenant_context_required" });
      expect(signedOut.status).toBe(401);
    } finally {
      container.shutdown();
    }
  });
});
