import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import type { Logger, NewActionInstance } from "@oneon/domain";
import { TransitionConflictError, LifecycleTransitionError } from "@oneon/domain";
import { createDatabase, runMigrations } from "./connection.js";
import { SqliteActionInstanceRepository } from "./repositories/sqlite-action-instance.repository.js";
import { SqliteActionConfigRepository } from "./repositories/sqlite-action-config.repository.js";
import { SqliteLegacyActionRepository } from "./repositories/sqlite-legacy-action.repository.js";
import { runActionDriftCheck } from "./action-drift-check.js";

const logger: Logger = { info() {}, warn() {}, error() {}, debug() {} };
const USER = { kind: "user" as const, userId: "user-A" };
const SYSTEM = { kind: "system" as const };

function newInstance(overrides: Partial<NewActionInstance> = {}): NewActionInstance {
  return {
    id: "act-1",
    scope: "personal",
    ownerId: "user-A",
    userId: "user-A",
    tenantId: null,
    locationIds: [],
    actionType: "notify",
    definitionVersion: "1",
    initiator: "rule:inbox.urgent_notify",
    initiatorUserId: null,
    input: { inboundItemId: "item-1" },
    evidence: [],
    idempotencyKey: "email:item-1",
    retryOf: null,
    attemptNumber: 1,
    resourceRef: "inbound_item:item-1",
    ...overrides,
  };
}

let db: Database.Database;
let repo: SqliteActionInstanceRepository;

beforeEach(() => {
  db = createDatabase(":memory:");
  runMigrations(db);
  db.prepare("INSERT INTO users (id, email) VALUES (?, ?), (?, ?)").run("user-A", "a@test.com", "user-B", "b@test.com");
  repo = new SqliteActionInstanceRepository(db, () => new Date("2026-10-01T12:00:00.000Z"));
});

describe("migration 014", () => {
  it("renames action_log to a read-only legacy table", () => {
    db.prepare(
      "INSERT INTO action_log_legacy (id, resource_id, action_type, risk_level, status, user_id) VALUES ('l1', 'item-1', 'archive', 'approval_required', 'proposed', 'user-A')",
    ).run();
    expect(() => db.prepare("UPDATE action_log_legacy SET status = 'rejected'").run()).toThrow(
      "action_log_legacy is read-only",
    );
    expect(() => db.prepare("DELETE FROM action_log_legacy").run()).toThrow("action_log_legacy is read-only");
    const legacyTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='action_log'").get();
    expect(legacyTable).toBeUndefined();
  });

  it("rejects a personal instance with a tenant and a tenant instance without one", () => {
    const insert = (scope: string, tenant: string | null, owner: string) =>
      db
        .prepare(
          `INSERT INTO action_instances (id, scope, owner_id, user_id, tenant_id, action_type, definition_version, status, initiator, input_json, idempotency_key, created_at, updated_at)
           VALUES (?, ?, ?, 'user-A', ?, 'notify', '1', 'proposed', 'user', '{}', ?, 'now', 'now')`,
        )
        .run(`x-${scope}-${tenant}`, scope, owner, tenant, `k-${scope}-${tenant}`);
    expect(() => insert("personal", "t-1", "user-A")).toThrow(/CHECK constraint failed/);
    expect(() => insert("tenant", null, "user-A")).toThrow(/CHECK constraint failed/);
  });
});

describe("SqliteActionInstanceRepository", () => {
  it("creates a proposed instance with event 1", () => {
    const { instance, created } = repo.create(newInstance(), USER, { note: "x" });
    expect(created).toBe(true);
    expect(instance.status).toBe("proposed");
    expect(instance.lastEventSeq).toBe(1);
    const events = repo.listEvents("user-A", "act-1");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ seq: 1, fromStatus: null, toStatus: "proposed", actor: USER, data: { note: "x" } });
  });

  it("returns the existing instance for a duplicate key without a new event", () => {
    repo.create(newInstance(), USER);
    const second = repo.create(newInstance({ id: "act-2" }), USER);
    expect(second.created).toBe(false);
    expect(second.instance.id).toBe("act-1");
    expect(db.prepare("SELECT COUNT(*) AS n FROM action_events").get()).toEqual({ n: 1 });
  });

  it("appends a transition and applies the patch", () => {
    repo.create(newInstance(), USER);
    repo.appendTransition({ actionId: "act-1", expectedStatus: "proposed", toStatus: "validating", actor: SYSTEM });
    const after = repo.appendTransition({
      actionId: "act-1",
      expectedStatus: "validating",
      toStatus: "approved",
      actor: { kind: "policy" },
      data: { decision: "auto" },
      patch: { resolved: { metrics: {} }, decision: { outcome: "auto" } },
    });
    expect(after).toMatchObject({ status: "approved", lastEventSeq: 3, resolved: { metrics: {} }, decision: { outcome: "auto" } });
    expect(repo.listEvents("user-A", "act-1").map((e) => e.toStatus)).toEqual(["proposed", "validating", "approved"]);
  });

  it("refuses a stale expected status and records nothing", () => {
    repo.create(newInstance(), USER);
    expect(() =>
      repo.appendTransition({ actionId: "act-1", expectedStatus: "validating", toStatus: "approved", actor: SYSTEM }),
    ).toThrow(TransitionConflictError);
    expect(repo.listEvents("user-A", "act-1")).toHaveLength(1);
  });

  it("refuses a transition the lifecycle does not allow", () => {
    repo.create(newInstance(), USER);
    expect(() =>
      repo.appendTransition({ actionId: "act-1", expectedStatus: "proposed", toStatus: "completed", actor: SYSTEM }),
    ).toThrow(LifecycleTransitionError);
  });

  it("makes events append-only", () => {
    repo.create(newInstance(), USER);
    expect(() => db.prepare("UPDATE action_events SET to_status = 'failed'").run()).toThrow("action_events is append-only");
    expect(() => db.prepare("DELETE FROM action_events").run()).toThrow("action_events is append-only");
  });

  it("never returns another owner's action or events", () => {
    repo.create(newInstance(), USER);
    expect(repo.findById("user-B", "act-1")).toBeNull();
    expect(repo.listEvents("user-B", "act-1")).toEqual([]);
    expect(repo.list("user-B")).toEqual([]);
    expect(repo.count("user-B")).toBe(0);
  });

  it("filters by status and resource", () => {
    repo.create(newInstance(), USER);
    repo.create(newInstance({ id: "act-2", idempotencyKey: "email:item-2", resourceRef: "inbound_item:item-2" }), USER);
    repo.appendTransition({ actionId: "act-2", expectedStatus: "proposed", toStatus: "cancelled", actor: USER });
    expect(repo.list("user-A", { statuses: ["cancelled"] }).map((i) => i.id)).toEqual(["act-2"]);
    expect(repo.list("user-A", { resourceRef: "inbound_item:item-1" }).map((i) => i.id)).toEqual(["act-1"]);
    expect(repo.count("user-A", { statuses: ["proposed", "cancelled"] })).toBe(2);
  });

  it("records heartbeats and undo starts without touching status or events", () => {
    repo.create(newInstance(), USER);
    repo.recordHeartbeat("act-1", "2026-10-01T12:01:00.000Z");
    repo.markUndoStarted("act-1", "2026-10-01T12:02:00.000Z");
    const after = repo.findById("user-A", "act-1")!;
    expect(after).toMatchObject({ status: "proposed", lastHeartbeatAt: "2026-10-01T12:01:00.000Z", undoStartedAt: "2026-10-01T12:02:00.000Z", lastEventSeq: 1 });
  });
});

describe("runActionDriftCheck", () => {
  it("rebuilds a drifted status from the events", () => {
    repo.create(newInstance(), USER);
    db.prepare("UPDATE action_instances SET status = 'completed' WHERE id = 'act-1'").run();
    expect(runActionDriftCheck(db, logger)).toBe(1);
    expect(repo.findById("user-A", "act-1")!.status).toBe("proposed");
    expect(runActionDriftCheck(db, logger)).toBe(0);
  });
});

describe("SqliteActionConfigRepository", () => {
  it("saves config and appends history that cannot be edited", () => {
    const config = new SqliteActionConfigRepository(db, () => new Date("2026-10-02T09:00:00.000Z"));
    config.save({ scope: "personal", ownerId: "user-A", actionType: "create_reminder", configJson: '{"approval":{"mode":"auto"}}', changedBy: "user-A" });
    config.save({ scope: "personal", ownerId: "user-A", actionType: "create_reminder", configJson: '{"approval":{"mode":"always"}}', changedBy: "user-A" });
    expect(config.get("personal", "user-A", "create_reminder")).toMatchObject({ configJson: '{"approval":{"mode":"always"}}', updatedBy: "user-A" });
    const history = config.history("personal", "user-A", "create_reminder", 10);
    expect(history.map((h) => [h.oldJson, h.newJson])).toEqual([
      ['{"approval":{"mode":"auto"}}', '{"approval":{"mode":"always"}}'],
      [null, '{"approval":{"mode":"auto"}}'],
    ]);
    expect(() => db.prepare("DELETE FROM action_definition_config_history").run()).toThrow(
      "action_definition_config_history is append-only",
    );
  });
});

describe("SqliteLegacyActionRepository", () => {
  it("lists only rows that were not imported", () => {
    db.prepare(
      `INSERT INTO action_log_legacy (id, resource_id, action_type, risk_level, status, user_id, created_at)
       VALUES ('l1','item-1','archive','approval_required','proposed','user-A','2026-09-01T00:00:00Z'),
              ('l2','item-2','notify','auto','executed','user-A','2026-09-02T00:00:00Z')`,
    ).run();
    const legacy = new SqliteLegacyActionRepository(db);
    expect(legacy.listUnimportedProposed("user-A").map((r) => r.id)).toEqual(["l1"]);
    repo.create(newInstance({ id: "act-9", actionType: "archive", idempotencyKey: "email:item-1" }), USER);
    legacy.recordImport("l1", "act-9");
    expect(legacy.listForUser("user-A", { limit: 10, offset: 0 }).map((r) => r.id)).toEqual(["l2"]);
    expect(legacy.countForUser("user-A")).toBe(1);
    expect(legacy.listUnimportedProposed("user-A")).toEqual([]);
  });
});
