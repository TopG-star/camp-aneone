import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { createDatabase, runMigrations } from "./connection.js";
import { SqliteAiDataChoiceRepository } from "./repositories/sqlite-ai-data-choice.repository.js";
import { SqliteModelAuditRepository } from "./repositories/sqlite-model-audit.repository.js";

let db: Database.Database;
beforeEach(() => {
  db = createDatabase(":memory:");
  runMigrations(db);
  db.prepare("INSERT INTO users (id, email) VALUES ('u1', 'gerry@test.com')").run();
});

const decision = (callId: string, overrides = {}) => ({
  id: `d-${callId}`,
  callId,
  createdAt: `2026-10-03T10:00:0${callId.slice(-1)}.000Z`,
  contextKind: "personal" as const,
  identityId: "u1",
  tenantId: null,
  membershipId: null,
  purpose: "chat_reply",
  channel: "web",
  provider: "deepseek",
  model: "deepseek-v4-pro",
  effectiveLimit: "D1" as const,
  layers: { provider: "D2" as const, choice: "D1" as const, purpose: "D2" as const },
  decision: "allow" as const,
  denyReason: null,
  released: [{ part: "user_message", field: "*", outcome: "sent" as const }],
  withheld: [],
  placeholderCount: 0,
  scannerHits: { D3: 0, D4: 0 },
  alert: false,
  policyFingerprint: "p".repeat(64),
  inputFingerprint: "i".repeat(64),
  keyVersion: 1,
  ...overrides,
});

describe("SqliteModelAuditRepository", () => {
  it("stores decisions and outcomes and lists them newest first", () => {
    const repo = new SqliteModelAuditRepository(db);
    repo.recordDecision(decision("c1"));
    repo.recordDecision(decision("c2", { decision: "deny", denyReason: "required_part_withheld", inputFingerprint: null }));
    repo.recordOutcome({ callId: "c1", createdAt: "2026-10-03T10:00:05.000Z", status: "answered", blockReason: null, attempts: 1, latencyMs: 900, inputTokens: null, outputTokens: null, checks: { O1: "pass", O2: "pass", O3: "pass", O4: "pass" }, outputFingerprint: "o".repeat(64), keyVersion: 1 });
    const recent = repo.listRecentForIdentity("u1", 10);
    expect(recent.map((r) => r.decision.callId)).toEqual(["c2", "c1"]);
    expect(recent[0].outcome).toBeNull();
    expect(recent[1].outcome).toMatchObject({ status: "answered", attempts: 1 });
  });
  it("is append-only", () => {
    const repo = new SqliteModelAuditRepository(db);
    repo.recordDecision(decision("c1"));
    expect(() => db.prepare("UPDATE model_call_decisions SET purpose = 'x'").run()).toThrow("model_call_decisions is append-only");
    expect(() => db.prepare("DELETE FROM model_call_decisions").run()).toThrow("model_call_decisions is append-only");
  });
  it("keeps outcomes append-only too", () => {
    const repo = new SqliteModelAuditRepository(db);
    repo.recordDecision(decision("c1"));
    repo.recordOutcome({ callId: "c1", createdAt: "2026-10-03T10:00:05.000Z", status: "failed", blockReason: null, attempts: 1, latencyMs: 1, inputTokens: null, outputTokens: null, checks: { O1: "pass", O2: "pass", O3: "pass", O4: "pass" }, outputFingerprint: null, keyVersion: 1 });
    expect(() => db.prepare("UPDATE model_call_outcomes SET attempts = 2").run()).toThrow("model_call_outcomes is append-only");
    expect(() => db.prepare("DELETE FROM model_call_outcomes").run()).toThrow("model_call_outcomes is append-only");
  });
});

describe("SqliteAiDataChoiceRepository", () => {
  it("returns the newest choice, so a later D1 revokes an earlier D2 (Review Focus 2)", () => {
    let t = 0;
    const repo = new SqliteAiDataChoiceRepository(db, () => `id${++t}`, () => new Date(Date.UTC(2026, 9, 3, 10, 0, t)));
    expect(repo.current("u1", "deepseek")).toBeNull();
    repo.record({ identityId: "u1", provider: "deepseek", maxClass: "D2", decidedOn: "2026-10-03", note: "n", confirmedAt: "2026-10-03T10:00:00.000Z" });
    expect(repo.current("u1", "deepseek")?.maxClass).toBe("D2");
    repo.record({ identityId: "u1", provider: "deepseek", maxClass: "D1", decidedOn: null, note: null, confirmedAt: "2026-10-04T10:00:00.000Z" });
    expect(repo.current("u1", "deepseek")?.maxClass).toBe("D1");
    expect(repo.history("u1")).toHaveLength(2);
  });
  it("is append-only and refuses classes other than D1 and D2", () => {
    const repo = new SqliteAiDataChoiceRepository(db);
    repo.record({ identityId: "u1", provider: "deepseek", maxClass: "D2", decidedOn: null, note: null, confirmedAt: "2026-10-03T10:00:00.000Z" });
    expect(() => db.prepare("DELETE FROM ai_data_choices").run()).toThrow("ai_data_choices is append-only");
    expect(() => repo.record({ identityId: "u1", provider: "deepseek", maxClass: "D3" as never, decidedOn: null, note: null, confirmedAt: "x" })).toThrow();
  });
});
