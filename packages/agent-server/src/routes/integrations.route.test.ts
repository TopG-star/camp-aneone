import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { createIntegrationsRouter } from "./integrations.route.js";
import type { IntegrationsRouteDeps } from "./integrations.route.js";
import type { UserRepository, OAuthTokenRepository } from "@oneon/domain";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function createMockUserRepo(): UserRepository {
  return {
    findById: vi.fn().mockReturnValue({ id: "u1", email: "alice@test.com", createdAt: "2026-01-01T00:00:00Z" }),
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

function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createDeps(overrides: Partial<IntegrationsRouteDeps> = {}): IntegrationsRouteDeps {
  return {
    userRepo: createMockUserRepo(),
    oauthTokenRepo: createMockOAuthTokenRepo(),
    logger: createMockLogger(),
    ...overrides,
  };
}

function createApp(deps: IntegrationsRouteDeps, userId = "u1") {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.userId = userId; next(); });
  app.use("/api/integrations", createIntegrationsRouter(deps));
  return app;
}

describe("Integrations Route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("POST /github/connect", () => {
    it("validates PAT via GitHub API and stores encrypted token", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ login: "alice-gh", email: "alice@github.com" }),
      });
      const deps = createDeps();
      const app = createApp(deps);

      const res = await request(app)
        .post("/api/integrations/github/connect")
        .send({ token: "ghp_validtoken123" });

      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(true);
      expect(res.body.login).toBe("alice-gh");
      expect(deps.oauthTokenRepo.upsert).toHaveBeenCalledTimes(1);

      const savedToken = (deps.oauthTokenRepo.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(savedToken.provider).toBe("github");
      expect(savedToken.userId).toBe("u1");
      expect(savedToken.accessToken).toBe("ghp_validtoken123");
      expect(savedToken.refreshToken).toBeNull();
      expect(savedToken.expiresAt).toBeNull();
    });

    it("returns 400 when token is missing", async () => {
      const app = createApp(createDeps());

      const res = await request(app)
        .post("/api/integrations/github/connect")
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("token");
    });

    it("returns 404 when user does not exist", async () => {
      const deps = createDeps();
      (deps.userRepo.findById as ReturnType<typeof vi.fn>).mockReturnValue(null);
      const app = createApp(deps, "nonexistent");

      const res = await request(app)
        .post("/api/integrations/github/connect")
        .send({ token: "ghp_abc123" });

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("User not found");
    });

    it("returns 401 when GitHub rejects the PAT", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Bad credentials"),
      });
      const app = createApp(createDeps());

      const res = await request(app)
        .post("/api/integrations/github/connect")
        .send({ token: "ghp_invalidtoken" });

      expect(res.status).toBe(401);
      expect(res.body.error).toContain("Invalid GitHub token");
    });
  });

  describe("POST /github/disconnect", () => {
    it("deletes the token and returns success", async () => {
      const deps = createDeps();
      (deps.oauthTokenRepo.get as ReturnType<typeof vi.fn>).mockReturnValue({
        provider: "github",
        userId: "u1",
        accessToken: "ghp_abc123",
        refreshToken: null,
        tokenType: "bearer",
        scope: "",
        expiresAt: null,
        providerEmail: "alice@github.com",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });
      const app = createApp(deps);

      const res = await request(app)
        .post("/api/integrations/github/disconnect")
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.disconnected).toBe(true);
      expect(deps.oauthTokenRepo.delete).toHaveBeenCalledWith("github", "u1");
    });

    it("returns 404 when no token exists", async () => {
      const deps = createDeps();
      const app = createApp(deps);

      const res = await request(app)
        .post("/api/integrations/github/disconnect")
        .send({});

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("No GitHub token");
    });
  });
});
