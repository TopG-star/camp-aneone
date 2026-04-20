import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createOAuthRouter } from "./oauth.route.js";
import type { OAuthRouteDeps } from "./oauth.route.js";
import type { UserRepository, OAuthTokenRepository, PreferenceRepository } from "@oneon/domain";

function createMockUserRepo(): UserRepository {
  return {
    findById: vi.fn().mockReturnValue({ id: "user-A", email: "alice@test.com", createdAt: "2026-01-01T00:00:00Z" }),
    findByEmail: vi.fn().mockReturnValue(null),
    upsert: vi.fn().mockReturnValue({ id: "u1", email: "alice@test.com", createdAt: "2026-01-01T00:00:00Z" }),
    list: vi.fn().mockReturnValue([]),
    delete: vi.fn(),
  };
}

function createMockOAuthTokenRepo(): OAuthTokenRepository {
  return {
    get: vi.fn().mockReturnValue(null),
    upsert: vi.fn(),
    delete: vi.fn(),
    listByUser: vi.fn().mockReturnValue([]),
  };
}

function createMockPreferenceRepo(): PreferenceRepository {
  const store = new Map<string, string>();
  return {
    get: vi.fn((key: string) => store.get(key) ?? null),
    set: vi.fn((key: string, value: string) => {
      store.set(key, value);
      return { key, value, updatedAt: new Date().toISOString() };
    }),
    getAll: vi.fn(() => []),
    delete: vi.fn((key: string) => { store.delete(key); }),
  };
}

function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createDeps(overrides: Partial<OAuthRouteDeps> = {}): OAuthRouteDeps {
  return {
    userRepo: createMockUserRepo(),
    oauthTokenRepo: createMockOAuthTokenRepo(),
    preferenceRepo: createMockPreferenceRepo(),
    googleClientId: "test-client-id",
    googleClientSecret: "test-client-secret",
    publicUrl: "http://localhost:3000",
    allowedEmails: ["alice@test.com", "bob@test.com"],
    logger: createMockLogger(),
    ...overrides,
  };
}

function createApp(deps: OAuthRouteDeps, userId: string | null = "user-A") {
  const app = express();
  app.use(express.json());
  if (userId !== null) {
    app.use((req, _res, next) => { req.userId = userId; next(); });
  }
  app.use("/api/oauth", createOAuthRouter(deps));
  return app;
}

describe("OAuth Route", () => {
  describe("GET /start/google", () => {
    it("returns a Google OAuth URL with state parameter", async () => {
      const deps = createDeps();
      const app = createApp(deps);

      const res = await request(app)
        .get("/api/oauth/start/google")
        .query({ returnTo: "/settings" });

      expect(res.status).toBe(200);
      expect(res.body.url).toBeTruthy();
      expect(res.body.url).toContain("accounts.google.com");
      expect(res.body.url).toContain("client_id=test-client-id");
      expect(res.body.url).toContain("access_type=offline");
      expect(res.body.url).toContain("prompt=consent");
      expect(res.body.url).toContain("state=");

      // State should be stored in preferences
      expect(deps.preferenceRepo.set).toHaveBeenCalledTimes(1);
      const stateCall = (deps.preferenceRepo.set as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(stateCall[0]).toMatch(/^oauth_state:/);
    });

    it("returns 401 when userId is missing", async () => {
      const app = createApp(createDeps(), null);

      const res = await request(app)
        .get("/api/oauth/start/google")
        .query({ returnTo: "/settings" });

      expect(res.status).toBe(401);
    });

    it("rejects returnTo with protocol scheme (open redirect)", async () => {
      const app = createApp(createDeps());

      const res = await request(app)
        .get("/api/oauth/start/google")
        .query({ returnTo: "https://evil.com/steal" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("returnTo");
    });

    it("rejects returnTo with double slashes (open redirect)", async () => {
      const app = createApp(createDeps());

      const res = await request(app)
        .get("/api/oauth/start/google")
        .query({ returnTo: "//evil.com" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("returnTo");
    });

    it("rejects returnTo with backslash (open redirect)", async () => {
      const app = createApp(createDeps());

      const res = await request(app)
        .get("/api/oauth/start/google")
        .query({ returnTo: "/\\evil.com" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("returnTo");
    });

    it("defaults returnTo to /settings when not provided", async () => {
      const deps = createDeps();
      const app = createApp(deps);

      const res = await request(app)
        .get("/api/oauth/start/google");

      expect(res.status).toBe(200);
      // State value should contain /settings as returnTo
      const stateCall = (deps.preferenceRepo.set as ReturnType<typeof vi.fn>).mock.calls[0];
      const stateValue = JSON.parse(stateCall[1]);
      expect(stateValue.returnTo).toBe("/settings");
    });

    it("returns 404 when user does not exist", async () => {
      const deps = createDeps();
      (deps.userRepo.findById as ReturnType<typeof vi.fn>).mockReturnValue(null);
      const app = createApp(deps);

      const res = await request(app)
        .get("/api/oauth/start/google")
        .query({ returnTo: "/settings" });

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("User not found");
    });
  });

  describe("GET /callback/google", () => {
    it("rejects when state parameter is missing", async () => {
      const app = createApp(createDeps());

      const res = await request(app)
        .get("/api/oauth/callback/google")
        .query({ code: "auth-code" });

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain("error=invalid_state");
    });

    it("rejects when state is not found in preferences (expired or invalid)", async () => {
      const app = createApp(createDeps());

      const res = await request(app)
        .get("/api/oauth/callback/google")
        .query({ code: "auth-code", state: "unknown-state" });

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain("error=invalid_state");
    });

    it("rejects expired state (older than 10 minutes)", async () => {
      const deps = createDeps();
      const stateKey = "oauth_state:test-state";
      const expiredState = JSON.stringify({
        returnTo: "/settings",
        userId: "u1",
        createdAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
      });
      (deps.preferenceRepo.get as ReturnType<typeof vi.fn>).mockImplementation(
        (key: string) => key === stateKey ? expiredState : null,
      );
      const app = createApp(deps);

      const res = await request(app)
        .get("/api/oauth/callback/google")
        .query({ code: "auth-code", state: "test-state" });

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain("error=state_expired");
    });

    it("redirects with error when Google returns an error param", async () => {
      const deps = createDeps();
      const stateKey = "oauth_state:test-state";
      const stateValue = JSON.stringify({
        returnTo: "/settings",
        userId: "u1",
        createdAt: new Date().toISOString(),
      });
      (deps.preferenceRepo.get as ReturnType<typeof vi.fn>).mockImplementation(
        (key: string) => key === stateKey ? stateValue : null,
      );
      const app = createApp(deps);

      const res = await request(app)
        .get("/api/oauth/callback/google")
        .query({ error: "access_denied", state: "test-state" });

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain("/settings");
      expect(res.headers.location).toContain("error=access_denied");
      // State should be cleaned up
      expect(deps.preferenceRepo.delete).toHaveBeenCalledWith(stateKey);
    });
  });

  describe("POST /disconnect/google", () => {
    it("deletes the token and returns success", async () => {
      const deps = createDeps();
      (deps.oauthTokenRepo.get as ReturnType<typeof vi.fn>).mockReturnValue({
        provider: "google",
        userId: "user-A",
        accessToken: "test",
        refreshToken: "test",
        tokenType: "bearer",
        scope: "",
        expiresAt: null,
        providerEmail: "alice@gmail.com",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });
      const app = createApp(deps);

      const res = await request(app)
        .post("/api/oauth/disconnect/google")
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.disconnected).toBe(true);
      expect(deps.oauthTokenRepo.delete).toHaveBeenCalledWith("google", "user-A");
    });

    it("returns 404 when no token exists", async () => {
      const deps = createDeps();
      const app = createApp(deps);

      const res = await request(app)
        .post("/api/oauth/disconnect/google")
        .send({});

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("No Google token");
    });

    it("returns 401 when userId is missing", async () => {
      const app = createApp(createDeps(), null);

      const res = await request(app)
        .post("/api/oauth/disconnect/google")
        .send({});

      expect(res.status).toBe(401);
    });
  });
});
