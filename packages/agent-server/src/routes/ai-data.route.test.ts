import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import Database from "better-sqlite3";
import { AiDataViewSchema } from "@oneon/contracts";
import { createModelGateway, Fingerprinter, type ModelProvider } from "@oneon/application";
import { runMigrations, SqliteAiDataChoiceRepository, SqliteModelAuditRepository } from "@oneon/infrastructure";
import { createAiDataRouter } from "./ai-data.route.js";

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
let app: express.Express;
let choices: SqliteAiDataChoiceRepository;

beforeEach(() => {
  const db = new Database(":memory:");
  runMigrations(db);
  db.prepare("INSERT INTO users (id, email) VALUES ('user-A', 'a@test.com'), ('user-B', 'b@test.com')").run();
  choices = new SqliteAiDataChoiceRepository(db);
  const audit = new SqliteModelAuditRepository(db);
  const provider: ModelProvider = { id: "deepseek", complete: async () => ({ text: "{}" }) };
  const routing = { standard: "deepseek" as const, reasoning: "deepseek" as const };
  const gateway = createModelGateway({
    providers: { deepseek: provider }, overrides: new Map(), routing, models: { deepseek: { standard: "s", reasoning: "r" } },
    choices, audit, fingerprinter: new Fingerprinter("k".repeat(32), 1), maxRetries: 0, timeouts: { standard: 1, reasoning: 1 }, logger,
  });
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as { userId?: string }).userId = req.header("x-test-user") ?? undefined; next(); });
  app.use("/api/ai-data", createAiDataRouter({ gateway, routing, overrides: new Map(), configuredProviders: ["deepseek"], choices, audit, logger }));
});

describe("AI data API", () => {
  it("shows the recorded 2026-10-03 decision as pending and email classification paused", async () => {
    const res = await request(app).get("/api/ai-data").set("x-test-user", "user-A").expect(200);
    expect(AiDataViewSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.pendingDecision).toMatchObject({ provider: "deepseek", maxClass: "D2", decidedOn: "2026-10-03" });
    expect(res.body.emailClassification).toEqual({
      active: false,
      reason: "Email classification needs your approval to send email content (D2) to DeepSeek. Choose D2 for DeepSeek in Settings → AI data to resume.",
    });
    expect(res.body.providers[0]).toMatchObject({ id: "deepseek", personalChoice: "D1", configured: true, review: "unreviewed" });
  });

  it("confirms the recorded decision with its date and note, and resumes email classification", async () => {
    const res = await request(app).post("/api/ai-data/choices").set("x-test-user", "user-A").send({ provider: "deepseek", maxClass: "D2" }).expect(200);
    expect(res.body.pendingDecision).toBeNull();
    expect(res.body.emailClassification).toEqual({ active: true, reason: null });
    expect(choices.current("user-A", "deepseek")).toMatchObject({
      maxClass: "D2",
      decidedOn: "2026-10-03",
      note: "Approved by Gerry in the 2026-10-03 design session for his personal email, pending confirmation after checking DeepSeek's current terms.",
    });
  });

  it("revokes by choosing D1", async () => {
    await request(app).post("/api/ai-data/choices").set("x-test-user", "user-A").send({ provider: "deepseek", maxClass: "D2" });
    const res = await request(app).post("/api/ai-data/choices").set("x-test-user", "user-A").send({ provider: "deepseek", maxClass: "D1" }).expect(200);
    expect(res.body.emailClassification.active).toBe(false);
    expect(choices.current("user-A", "deepseek")).toMatchObject({ maxClass: "D1", decidedOn: null, note: null });
  });

  it.each([
    [{ provider: "deepseek", maxClass: "D3" }],
    [{ provider: "openai", maxClass: "D2" }],
    [{ provider: "deepseek", maxClass: "D2", identityId: "user-B" }],
  ])("refuses %o with 422", async (body) => {
    await request(app).post("/api/ai-data/choices").set("x-test-user", "user-A").send(body).expect(422);
  });

  it("keeps each user's choices and calls separate", async () => {
    await request(app).post("/api/ai-data/choices").set("x-test-user", "user-A").send({ provider: "deepseek", maxClass: "D2" });
    const res = await request(app).get("/api/ai-data").set("x-test-user", "user-B").expect(200);
    expect(res.body.providers[0].personalChoice).toBe("D1");
    expect(res.body.pendingDecision).not.toBeNull();
    expect(res.body.recent).toEqual([]);
  });
});
