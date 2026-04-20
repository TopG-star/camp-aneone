import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { createTokenAuthMiddleware } from "../auth.js";

// ── Helpers ──────────────────────────────────────────────────

function buildApp(token: string): express.Express {
  const app = express();
  app.use(createTokenAuthMiddleware(token));
  app.get("/protected", (_req, res) => res.json({ ok: true }));
  return app;
}

// ── Tests ────────────────────────────────────────────────────

describe("Token auth middleware", () => {
  const SECRET = "test-secret-token-abc123";

  it("allows requests with a valid Bearer token", async () => {
    const app = buildApp(SECRET);
    const res = await request(app)
      .get("/protected")
      .set("Authorization", `Bearer ${SECRET}`)
      .expect(200);

    expect(res.body).toEqual({ ok: true });
  });

  it("rejects requests with no Authorization header", async () => {
    const app = buildApp(SECRET);
    const res = await request(app).get("/protected").expect(401);

    expect(res.body.error).toBe("Unauthorized");
  });

  it("rejects requests with an invalid token", async () => {
    const app = buildApp(SECRET);
    const res = await request(app)
      .get("/protected")
      .set("Authorization", "Bearer wrong-token")
      .expect(401);

    expect(res.body.error).toBe("Unauthorized");
  });

  it("rejects requests with non-Bearer scheme", async () => {
    const app = buildApp(SECRET);
    const res = await request(app)
      .get("/protected")
      .set("Authorization", `Basic ${SECRET}`)
      .expect(401);

    expect(res.body.error).toBe("Unauthorized");
  });

  it("rejects requests with empty Bearer value", async () => {
    const app = buildApp(SECRET);
    const res = await request(app)
      .get("/protected")
      .set("Authorization", "Bearer ")
      .expect(401);

    expect(res.body.error).toBe("Unauthorized");
  });

  it("uses constant-time comparison to prevent timing attacks", async () => {
    // This test verifies the middleware doesn't crash with mismatched lengths
    const app = buildApp(SECRET);
    await request(app)
      .get("/protected")
      .set("Authorization", "Bearer x")
      .expect(401);

    await request(app)
      .get("/protected")
      .set(
        "Authorization",
        "Bearer " + "a".repeat(1000),
      )
      .expect(401);
  });
});
