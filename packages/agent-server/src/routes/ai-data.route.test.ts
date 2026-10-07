import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import Database from "better-sqlite3";
import { AiDataViewSchema, AiDataCallViewSchema } from "@oneon/contracts";
import { createModelGateway, Fingerprinter, emailClassificationRequest, type ModelProvider, type ModelGateway, type ProviderId, type ProviderOverride } from "@oneon/application";
import { runMigrations, SqliteAiDataChoiceRepository, SqliteModelAuditRepository } from "@oneon/infrastructure";
import { createAiDataRouter } from "./ai-data.route.js";

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
let app: express.Express;
let choices: SqliteAiDataChoiceRepository;
let gateway: ModelGateway;
let dbRef: Database.Database;

function mount(overrides: Map<ProviderId, ProviderOverride>, db: Database.Database, routingWarnings: Array<{ role: "standard" | "reasoning" | "shadow"; provider: ProviderId }> = []) {
  const audit = new SqliteModelAuditRepository(db);
  const provider: ModelProvider = { id: "deepseek", complete: async () => ({ text: "{}" }) };
  const routing = { standard: "deepseek" as const, reasoning: "deepseek" as const };
  gateway = createModelGateway({
    providers: { deepseek: provider }, overrides, routing, models: { deepseek: { standard: "s", reasoning: "r" } },
    choices, audit, fingerprinter: new Fingerprinter("k".repeat(32), 1), maxRetries: 0, timeouts: { standard: 1, reasoning: 1 }, logger,
  });
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { (req as { userId?: string }).userId = req.header("x-test-user") ?? undefined; next(); });
  a.use("/api/ai-data", createAiDataRouter({ gateway, routing, overrides, configuredProviders: ["deepseek"], routingWarnings, choices, audit, logger }));
  return a;
}

beforeEach(() => {
  const db = new Database(":memory:");
  runMigrations(db);
  db.prepare("INSERT INTO users (id, email) VALUES ('user-A', 'a@test.com'), ('user-B', 'b@test.com')").run();
  choices = new SqliteAiDataChoiceRepository(db);
  app = mount(new Map(), db);
  dbRef = db;
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

  it("keeps each user's choices and calls separate, and returns no content", async () => {
    await request(app).post("/api/ai-data/choices").set("x-test-user", "user-A").send({ provider: "deepseek", maxClass: "D2" });
    const item = { from: "ama.secret@x.com", subject: "Zebra invoice subject", bodyPreview: "Pay the quokka account by Friday", receivedAt: "2026-10-03T09:00:00Z", source: "gmail" as const };
    await gateway.beginTurn({ kind: "personal", identityId: "user-A" }).call(emailClassificationRequest(item));

    const a = await request(app).get("/api/ai-data").set("x-test-user", "user-A").expect(200);
    expect(a.body.recent).toHaveLength(1);
    expect(Object.keys(a.body.recent[0]).sort()).toEqual(Object.keys(AiDataCallViewSchema.shape).sort());
    for (const value of [item.from, item.subject, item.bodyPreview]) expect(JSON.stringify(a.body)).not.toContain(value);

    const b = await request(app).get("/api/ai-data").set("x-test-user", "user-B").expect(200);
    expect(b.body.providers[0].personalChoice).toBe("D1");
    expect(b.body.pendingDecision).not.toBeNull();
    expect(b.body.recent).toEqual([]);
  });

  it("says the provider is unavailable, not 'choose D2', when it is suspended", async () => {
    const suspended = mount(new Map<ProviderId, ProviderOverride>([["deepseek", { kind: "suspended" }]]), dbRef);
    const res = await request(suspended).get("/api/ai-data").set("x-test-user", "user-A").expect(200);
    expect(res.body.emailClassification).toEqual({ active: false, reason: "Email classification is paused: DeepSeek is currently unavailable." });
  });

  it("says the platform limits what can be sent, not 'choose D2', when an override caps the provider below D2", async () => {
    const capped = mount(new Map<ProviderId, ProviderOverride>([["deepseek", { kind: "limit", max: "D1" }]]), dbRef);
    choices.record({ identityId: "user-A", provider: "deepseek", maxClass: "D2", decidedOn: null, note: null, confirmedAt: "2026-10-04T10:00:00.000Z" });
    const res = await request(capped).get("/api/ai-data").set("x-test-user", "user-A").expect(200);
    expect(res.body.emailClassification).toEqual({
      active: false,
      reason: "Email classification is paused: the platform currently limits what can be sent to DeepSeek.",
    });
  });

  it("passes the routing warnings through", async () => {
    const warnings = [{ role: "reasoning" as const, provider: "anthropic" as const }];
    const warned = mount(new Map(), dbRef, warnings);
    const res = await request(warned).get("/api/ai-data").set("x-test-user", "user-A").expect(200);
    expect(AiDataViewSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.routingWarnings).toEqual(warnings);
    const none = await request(app).get("/api/ai-data").set("x-test-user", "user-A").expect(200);
    expect(none.body.routingWarnings).toEqual([]);
  });
});
