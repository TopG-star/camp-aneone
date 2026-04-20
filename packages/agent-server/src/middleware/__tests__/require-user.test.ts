import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { requireUser } from "../require-user.js";

function buildApp(setUserId?: string): express.Express {
  const app = express();
  // Optionally simulate auth middleware setting req.userId
  if (setUserId !== undefined) {
    app.use((req, _res, next) => {
      req.userId = setUserId;
      next();
    });
  }
  app.use(requireUser);
  app.get("/test", (_req, res) => {
    res.json({ ok: true, userId: _req.userId });
  });
  return app;
}

describe("requireUser middleware", () => {
  it("returns 401 when req.userId is not set", async () => {
    const app = buildApp();
    const res = await request(app).get("/test");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Authentication required");
  });

  it("calls next when req.userId is set", async () => {
    const app = buildApp("user-123");
    const res = await request(app).get("/test");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, userId: "user-123" });
  });

  it("returns 401 when req.userId is undefined (empty string is falsy edge case)", async () => {
    const app = buildApp("");
    const res = await request(app).get("/test");
    // Empty string is falsy, should return 401
    expect(res.status).toBe(401);
  });
});
