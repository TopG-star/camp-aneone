import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createDatabase } from "../connection.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("Migration 012 inbound items user scope", () => {
  it("supports per-user uniqueness and preserves legacy null-user idempotency", () => {
    const db = createDatabase(":memory:");

    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE TABLE inbound_items (
        id            TEXT PRIMARY KEY,
        source        TEXT NOT NULL CHECK (source IN ('gmail', 'outlook', 'teams', 'github')),
        external_id   TEXT NOT NULL,
        "from"        TEXT NOT NULL,
        subject       TEXT NOT NULL DEFAULT '',
        body_preview  TEXT NOT NULL DEFAULT '',
        received_at   TEXT NOT NULL,
        raw_json      TEXT NOT NULL DEFAULT '{}',
        classified_at TEXT,
        created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        thread_id     TEXT,
        labels        TEXT NOT NULL DEFAULT '[]',
        classify_attempts INTEGER NOT NULL DEFAULT 0,
        user_id       TEXT REFERENCES users (id),
        UNIQUE (source, external_id)
      );
    `);

    db.prepare("INSERT INTO users (id, email) VALUES (?, ?)").run("user-A", "a@example.com");
    db.prepare("INSERT INTO users (id, email) VALUES (?, ?)").run("user-B", "b@example.com");

    db.prepare(`
      INSERT INTO inbound_items (
        id, source, external_id, "from", subject, body_preview,
        received_at, raw_json, thread_id, labels, classified_at,
        classify_attempts, user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-1",
      "teams",
      "msg-1",
      "alice@company.com",
      "Standup",
      "A",
      "2026-05-05T10:00:00.000Z",
      "{}",
      null,
      "[]",
      null,
      0,
      "user-A",
      "2026-05-05T10:00:00.000Z",
      "2026-05-05T10:00:00.000Z",
    );

    const migrationSql = readFileSync(
      join(__dirname, "012_inbound_items_user_scope.sql"),
      "utf-8",
    );

    db.exec(migrationSql);

    const userBInsert = db.prepare(`
      INSERT INTO inbound_items (
        id, source, external_id, "from", subject, body_preview,
        received_at, raw_json, thread_id, labels, classified_at,
        classify_attempts, user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    expect(() =>
      userBInsert.run(
        "user-b-row",
        "teams",
        "msg-1",
        "bob@company.com",
        "Standup",
        "B",
        "2026-05-05T10:01:00.000Z",
        "{}",
        null,
        "[]",
        null,
        0,
        "user-B",
        "2026-05-05T10:01:00.000Z",
        "2026-05-05T10:01:00.000Z",
      ),
    ).not.toThrow();

    const duplicateUserAInsert = db.prepare(`
      INSERT INTO inbound_items (
        id, source, external_id, "from", subject, body_preview,
        received_at, raw_json, thread_id, labels, classified_at,
        classify_attempts, user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    expect(() =>
      duplicateUserAInsert.run(
        "user-a-dup",
        "teams",
        "msg-1",
        "alice@company.com",
        "Standup",
        "A2",
        "2026-05-05T10:02:00.000Z",
        "{}",
        null,
        "[]",
        null,
        0,
        "user-A",
        "2026-05-05T10:02:00.000Z",
        "2026-05-05T10:02:00.000Z",
      ),
    ).toThrow();

    const nullUserInsert = db.prepare(`
      INSERT INTO inbound_items (
        id, source, external_id, "from", subject, body_preview,
        received_at, raw_json, thread_id, labels, classified_at,
        classify_attempts, user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    expect(() =>
      nullUserInsert.run(
        "null-user-1",
        "teams",
        "msg-1",
        "legacy@company.com",
        "Legacy",
        "L1",
        "2026-05-05T10:03:00.000Z",
        "{}",
        null,
        "[]",
        null,
        0,
        null,
        "2026-05-05T10:03:00.000Z",
        "2026-05-05T10:03:00.000Z",
      ),
    ).not.toThrow();

    expect(() =>
      nullUserInsert.run(
        "null-user-2",
        "teams",
        "msg-1",
        "legacy@company.com",
        "Legacy",
        "L2",
        "2026-05-05T10:04:00.000Z",
        "{}",
        null,
        "[]",
        null,
        0,
        null,
        "2026-05-05T10:04:00.000Z",
        "2026-05-05T10:04:00.000Z",
      ),
    ).toThrow();

    const rows = db
      .prepare("SELECT user_id, source, external_id FROM inbound_items WHERE source = ? AND external_id = ? ORDER BY user_id")
      .all("teams", "msg-1") as Array<{ user_id: string | null }>;

    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.user_id)).toEqual([null, "user-A", "user-B"]);
  });
});
