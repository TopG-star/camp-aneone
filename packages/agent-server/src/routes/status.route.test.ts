import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { Logger } from "@oneon/domain";
import type { AppContainer } from "../container.js";
import { createStatusRouter } from "./status.route.js";

const logger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

let app: express.Express;
let container: AppContainer;

beforeEach(() => {
  container = {
    env: {
      GOOGLE_CLIENT_ID: "client-id",
      GOOGLE_CLIENT_SECRET: "client-secret",
      GOOGLE_REFRESH_TOKEN: "refresh-token",
      GITHUB_TOKEN: "ghp_test",
      ANTHROPIC_API_KEY: "sk-test",
      LLM_PROVIDER: "anthropic",
    },
    calendarPort: { listEvents: vi.fn() },
    oauthTokenRepo: null,
    userRepo: null,
  } as unknown as AppContainer;

  app = express();
  app.use((req, _res, next) => { req.userId = "user-A"; next(); });
  app.use("/api/status", createStatusRouter({ container, logger }));
});

describe("GET /api/status", () => {
  it("returns integration statuses", async () => {
    const res = await request(app).get("/api/status");
    expect(res.status).toBe(200);
    expect(res.body.integrations).toHaveLength(5);
    expect(res.body).toHaveProperty("uptime");

    const gmail = res.body.integrations.find((i: any) => i.name === "gmail");
    expect(gmail.connected).toBe(true);
    expect(gmail.source).toBe("env");

    const github = res.body.integrations.find((i: any) => i.name === "github");
    expect(github.connected).toBe(true);
    expect(github.source).toBe("env");

    const calendar = res.body.integrations.find((i: any) => i.name === "calendar");
    expect(calendar.connected).toBe(true);

    const llm = res.body.integrations.find((i: any) => i.name === "llm");
    expect(llm.connected).toBe(true);
  });

  it("shows disconnected when tokens missing", async () => {
    container = {
      env: { LLM_PROVIDER: "anthropic" },
      calendarPort: null,
      oauthTokenRepo: null,
      userRepo: null,
    } as unknown as AppContainer;
    app = express();
    app.use((req, _res, next) => { req.userId = "user-A"; next(); });
    app.use("/api/status", createStatusRouter({ container, logger }));

    const res = await request(app).get("/api/status");
    const gmail = res.body.integrations.find((i: any) => i.name === "gmail");
    expect(gmail.connected).toBe(false);

    const calendar = res.body.integrations.find((i: any) => i.name === "calendar");
    expect(calendar.connected).toBe(false);
  });

  it("shows db source when oauthTokenRepo has tokens", async () => {
    container = {
      env: {
        ANTHROPIC_API_KEY: "sk-test",
        LLM_PROVIDER: "anthropic",
        GOOGLE_CLIENT_ID: "client-id",
        GOOGLE_CLIENT_SECRET: "client-secret",
      },
      calendarPort: null,
      userRepo: null,
      oauthTokenRepo: {
        get: vi.fn(),
        upsert: vi.fn(),
        delete: vi.fn(),
        listByUser: vi.fn().mockReturnValue([
          { provider: "google", userId: "user-A", providerEmail: "alice@gmail.com" },
          { provider: "github", userId: "user-A", providerEmail: "alice@gh.com" },
        ]),
      },
    } as unknown as AppContainer;
    app = express();
    app.use((req, _res, next) => { req.userId = "user-A"; next(); });
    app.use("/api/status", createStatusRouter({ container, logger }));

    const res = await request(app).get("/api/status");
    const gmail = res.body.integrations.find((i: any) => i.name === "gmail");
    expect(gmail.connected).toBe(true);
    expect(gmail.source).toBe("db");
    expect(gmail.connectedAs).toBe("alice@gmail.com");

    const github = res.body.integrations.find((i: any) => i.name === "github");
    expect(github.connected).toBe(true);
    expect(github.source).toBe("db");
    expect(github.connectedAs).toBe("alice@gh.com");
  });

  it("marks gmail disconnected when only db token exists but Google client credentials are missing", async () => {
    container = {
      env: { ANTHROPIC_API_KEY: "sk-test", LLM_PROVIDER: "anthropic" },
      calendarPort: null,
      userRepo: null,
      oauthTokenRepo: {
        get: vi.fn(),
        upsert: vi.fn(),
        delete: vi.fn(),
        listByUser: vi.fn().mockReturnValue([
          { provider: "google", userId: "user-A", providerEmail: "alice@gmail.com" },
        ]),
      },
    } as unknown as AppContainer;
    app = express();
    app.use((req, _res, next) => {
      req.userId = "user-A";
      next();
    });
    app.use("/api/status", createStatusRouter({ container, logger }));

    const res = await request(app).get("/api/status");
    const gmail = res.body.integrations.find((i: any) => i.name === "gmail");

    expect(gmail.connected).toBe(false);
    expect(gmail.source).toBe("none");
    expect(gmail.detail).toContain("missing Google client credentials");
  });

  it("shows llm connected=true with detail='deepseek' when LLM_PROVIDER is deepseek and key is present", async () => {
    container = {
      env: { LLM_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "sk-ds-test" },
      calendarPort: null,
      oauthTokenRepo: null,
      userRepo: null,
    } as unknown as AppContainer;
    app = express();
    app.use((req, _res, next) => { req.userId = "user-A"; next(); });
    app.use("/api/status", createStatusRouter({ container, logger }));

    const res = await request(app).get("/api/status");
    const llm = res.body.integrations.find((i: any) => i.name === "llm");
    expect(llm.connected).toBe(true);
    expect(llm.detail).toBe("deepseek");
  });

  it("shows llm connected=false when LLM_PROVIDER is deepseek but no DEEPSEEK_API_KEY", async () => {
    container = {
      env: { LLM_PROVIDER: "deepseek" },
      calendarPort: null,
      oauthTokenRepo: null,
      userRepo: null,
    } as unknown as AppContainer;
    app = express();
    app.use((req, _res, next) => { req.userId = "user-A"; next(); });
    app.use("/api/status", createStatusRouter({ container, logger }));

    const res = await request(app).get("/api/status");
    const llm = res.body.integrations.find((i: any) => i.name === "llm");
    expect(llm.connected).toBe(false);
    expect(llm.detail).toBe("not configured");
  });
});