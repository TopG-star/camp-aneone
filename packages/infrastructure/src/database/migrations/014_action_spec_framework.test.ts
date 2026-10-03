import { describe, expect, it } from "vitest";
import { createDatabase, runMigrations } from "../connection.js";

/** Applies migrations 001–013 only, by marking 014 as applied for the first run. */
function databaseAt013() {
  const db = createDatabase(":memory:");
  db.exec(`
    CREATE TABLE schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    INSERT INTO schema_migrations (version, name) VALUES (14, 'action_spec_framework');
  `);
  runMigrations(db);
  db.prepare("DELETE FROM schema_migrations WHERE version = 14").run();
  return db;
}

describe("Migration 014 over a database with existing action_log rows", () => {
  it("keeps every row in a read-only action_log_legacy with clean foreign keys", () => {
    const db = databaseAt013();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'action_instances'").get()).toBeUndefined();

    db.prepare("INSERT INTO users (id, email) VALUES (?, ?)").run("user-A", "a@example.com");
    const insert = db.prepare(
      `INSERT INTO action_log (id, resource_id, action_type, risk_level, status, payload_json, result_json, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run("l-reminder", "deadline-1", "create_reminder", "approval_required", "proposed", '{"deadlineId":"deadline-1"}', null, "user-A");
    insert.run("l-classify", "item-1", "classify", "auto", "executed", "{}", '{"ok":true}', null);
    insert.run("l-notify", "item-2", "notify", "auto", "executed", '{"title":"Urgent"}', '{"notificationId":"n1"}', "user-A");

    runMigrations(db);

    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = 14").get()).toEqual({ version: 14 });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'action_log'").get()).toBeUndefined();
    const rows = db
      .prepare("SELECT id, action_type, status, user_id, payload_json, result_json FROM action_log_legacy ORDER BY id")
      .all();
    expect(rows).toEqual([
      { id: "l-classify", action_type: "classify", status: "executed", user_id: null, payload_json: "{}", result_json: '{"ok":true}' },
      { id: "l-notify", action_type: "notify", status: "executed", user_id: "user-A", payload_json: '{"title":"Urgent"}', result_json: '{"notificationId":"n1"}' },
      { id: "l-reminder", action_type: "create_reminder", status: "proposed", user_id: "user-A", payload_json: '{"deadlineId":"deadline-1"}', result_json: null },
    ]);

    expect(() => db.prepare("UPDATE action_log_legacy SET status = 'rejected' WHERE id = 'l-reminder'").run()).toThrow(
      "action_log_legacy is read-only",
    );
    expect(() => db.prepare("DELETE FROM action_log_legacy WHERE id = 'l-classify'").run()).toThrow("action_log_legacy is read-only");
    expect(db.prepare("SELECT COUNT(*) AS n FROM action_log_legacy").get()).toEqual({ n: 3 });

    expect(() =>
      db.prepare("INSERT INTO action_legacy_imports (legacy_id, action_id, imported_at) VALUES ('missing', 'missing', 'now')").run(),
    ).toThrow(/FOREIGN KEY constraint failed/);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
