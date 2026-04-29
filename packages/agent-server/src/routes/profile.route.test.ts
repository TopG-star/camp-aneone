import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { UserProfileResponseSchema } from "@oneon/contracts";
import type { UserProfileRepository, UserProfile } from "@oneon/domain";
import {
  createProfileRouter,
  type ProfileRouteDeps,
} from "./profile.route.js";

function createMockProfileRepo(): UserProfileRepository {
  const state = new Map<string, UserProfile>();

  return {
    findByUserId: vi.fn((userId: string) => state.get(userId) ?? null),
    upsert: vi.fn((input) => {
      const now = "2026-04-22T00:00:00.000Z";
      const existing = state.get(input.userId);
      const profile: UserProfile = {
        userId: input.userId,
        preferredName: input.preferredName,
        nickname: input.nickname,
        salutationMode: input.salutationMode ?? "sir_with_name",
        communicationStyle: input.communicationStyle ?? "friendly",
        timezone: input.timezone ?? "UTC",
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      state.set(input.userId, profile);
      return profile;
    }),
    deleteByUserId: vi.fn(),
  };
}

function createDeps(overrides: Partial<ProfileRouteDeps> = {}): ProfileRouteDeps {
  return {
    userProfileRepo: createMockProfileRepo(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    ...overrides,
  };
}

function createApp(deps: ProfileRouteDeps, userId = "u1") {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = userId;
    next();
  });
  app.use("/api/profile", createProfileRouter(deps));
  return app;
}

describe("Profile Route", () => {
  let deps: ProfileRouteDeps;
  let app: express.Express;

  beforeEach(() => {
    deps = createDeps();
    app = createApp(deps);
  });

  describe("GET /api/profile", () => {
    it("returns default profile settings when profile does not exist", async () => {
      const res = await request(app).get("/api/profile");

      expect(res.status).toBe(200);
      expect(res.body.profile).toEqual({
        preferredName: null,
        nickname: null,
        salutationMode: "sir_with_name",
        communicationStyle: "friendly",
        timezone: "UTC",
      });
      expect(deps.userProfileRepo.findByUserId).toHaveBeenCalledWith("u1");
    });

    it("returns persisted profile settings when profile exists", async () => {
      deps.userProfileRepo.upsert({
        userId: "u1",
        preferredName: "Adewale",
        nickname: "Wale",
        salutationMode: "nickname",
        communicationStyle: "concise",
        timezone: "Africa/Lagos",
      });

      const res = await request(app).get("/api/profile");

      expect(res.status).toBe(200);
      expect(res.body.profile).toEqual({
        preferredName: "Adewale",
        nickname: "Wale",
        salutationMode: "nickname",
        communicationStyle: "concise",
        timezone: "Africa/Lagos",
      });
    });

    it("returns a response matching shared profile contract schema", async () => {
      const res = await request(app).get("/api/profile");

      expect(res.status).toBe(200);
      const parsed = UserProfileResponseSchema.safeParse(res.body);
      expect(parsed.success).toBe(true);
    });
  });

  describe("PUT /api/profile", () => {
    it("creates profile settings with defaults for omitted fields", async () => {
      const res = await request(app)
        .put("/api/profile")
        .send({
          profile: {
            preferredName: "Adewale",
            nickname: null,
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.profile).toEqual({
        preferredName: "Adewale",
        nickname: null,
        salutationMode: "sir_with_name",
        communicationStyle: "friendly",
        timezone: "UTC",
      });
    });

    it("updates profile settings partially while preserving existing values", async () => {
      deps.userProfileRepo.upsert({
        userId: "u1",
        preferredName: "Adewale",
        nickname: "Wale",
        salutationMode: "sir_with_name",
        communicationStyle: "friendly",
        timezone: "Africa/Lagos",
      });

      const res = await request(app)
        .put("/api/profile")
        .send({
          profile: {
            communicationStyle: "technical",
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.profile).toEqual({
        preferredName: "Adewale",
        nickname: "Wale",
        salutationMode: "sir_with_name",
        communicationStyle: "technical",
        timezone: "Africa/Lagos",
      });
    });

    it("returns 400 for invalid salutationMode", async () => {
      const res = await request(app)
        .put("/api/profile")
        .send({
          profile: {
            salutationMode: "boss",
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("salutationMode");
    });

    it("returns 400 when salutationMode is nickname but nickname is missing", async () => {
      const res = await request(app)
        .put("/api/profile")
        .send({
          profile: {
            salutationMode: "nickname",
            nickname: null,
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("nickname");
    });

    it("returns 400 when profile payload is missing or invalid", async () => {
      const res = await request(app)
        .put("/api/profile")
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("profile");
    });

    it("returns 500 when repository throws", async () => {
      const failingDeps = createDeps({
        userProfileRepo: {
          ...createMockProfileRepo(),
          findByUserId: vi.fn(() => {
            throw new Error("DB down");
          }),
        },
      });
      const failingApp = createApp(failingDeps);

      const res = await request(failingApp).get("/api/profile");

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Internal server error");
    });
  });
});
