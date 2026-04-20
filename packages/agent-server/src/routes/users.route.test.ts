import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createUsersRouter } from "./users.route.js";
import type { UsersRouteDeps } from "./users.route.js";
import type { UserRepository } from "@oneon/domain";

function createMockUserRepo(): UserRepository {
  return {
    findById: vi.fn().mockReturnValue(null),
    findByEmail: vi.fn().mockReturnValue(null),
    upsert: vi.fn().mockImplementation(({ id, email }) => ({
      id,
      email,
      createdAt: "2026-01-01T00:00:00Z",
    })),
    list: vi.fn().mockReturnValue([]),
    delete: vi.fn(),
  };
}

function createDeps(overrides: Partial<UsersRouteDeps> = {}): UsersRouteDeps {
  return {
    userRepo: createMockUserRepo(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    ...overrides,
  };
}

function createApp(deps: UsersRouteDeps) {
  const app = express();
  app.use(express.json());
  app.use("/api/users", createUsersRouter(deps));
  return app;
}

describe("Users Route", () => {
  describe("POST /upsert", () => {
    it("creates a new user when email not found", async () => {
      const deps = createDeps();
      const app = createApp(deps);

      const res = await request(app)
        .post("/api/users/upsert")
        .send({ email: "Alice@Test.com" });

      expect(res.status).toBe(200);
      expect(res.body.created).toBe(true);
      expect(res.body.user.email).toBe("alice@test.com");
      expect(deps.userRepo.upsert).toHaveBeenCalledTimes(1);
    });

    it("returns existing user without creating", async () => {
      const deps = createDeps();
      (deps.userRepo.findByEmail as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "u1",
        email: "alice@test.com",
        createdAt: "2026-01-01T00:00:00Z",
      });
      const app = createApp(deps);

      const res = await request(app)
        .post("/api/users/upsert")
        .send({ email: "alice@test.com" });

      expect(res.status).toBe(200);
      expect(res.body.created).toBe(false);
      expect(res.body.user.id).toBe("u1");
      expect(deps.userRepo.upsert).not.toHaveBeenCalled();
    });

    it("returns 400 when email is missing", async () => {
      const app = createApp(createDeps());

      const res = await request(app)
        .post("/api/users/upsert")
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("email");
    });

    it("normalizes email to lowercase", async () => {
      const deps = createDeps();
      const app = createApp(deps);

      await request(app)
        .post("/api/users/upsert")
        .send({ email: "  BOB@Example.COM  " });

      expect(deps.userRepo.findByEmail).toHaveBeenCalledWith("bob@example.com");
    });
  });
});
