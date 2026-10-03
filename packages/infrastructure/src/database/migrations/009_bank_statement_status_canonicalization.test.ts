import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createDatabase } from "../connection.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("Migration 009 bank statement status canonicalization", () => {
  it("maps legacy statuses to discovered and enforces canonical status set", () => {
    const db = createDatabase(":memory:");

    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE TABLE bank_statements (
        id                      TEXT PRIMARY KEY,
        user_id                 TEXT NOT NULL REFERENCES users (id),
        source                  TEXT NOT NULL CHECK (source IN ('gmail', 'outlook', 'teams', 'github')),
        external_id             TEXT NOT NULL,
        message_id              TEXT NOT NULL,
        thread_id               TEXT,
        sender                  TEXT NOT NULL,
        sender_domain           TEXT NOT NULL,
        subject                 TEXT NOT NULL DEFAULT '',
        received_at             TEXT NOT NULL,
        status                  TEXT NOT NULL CHECK (status IN ('discovered', 'queued_for_parse', 'skipped_duplicate')),
        detection_rule_version  TEXT NOT NULL,
        created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE (user_id, source, external_id)
      );

      CREATE INDEX idx_bank_statements_user_id ON bank_statements (user_id);
      CREATE INDEX idx_bank_statements_status ON bank_statements (status);
      CREATE INDEX idx_bank_statements_received_at ON bank_statements (received_at DESC);
      CREATE INDEX idx_bank_statements_sender_domain ON bank_statements (sender_domain);
    `);

    db.prepare("INSERT INTO users (id, email) VALUES (?, ?)").run(
      "user-1",
      "user-1@example.com",
    );

    const insert = db.prepare(`
      INSERT INTO bank_statements (
        id, user_id, source, external_id, message_id, thread_id,
        sender, sender_domain, subject, received_at, status,
        detection_rule_version, created_at, updated_at
      ) VALUES (?, ?, 'gmail', ?, ?, 'thread-1', 'alerts@chase.com', 'chase.com', 'Statement', ?, ?, 'fin-001a-v1', ?, ?)
    `);

    insert.run(
      "s1",
      "user-1",
      "ext-1",
      "msg-1",
      "2026-04-29T09:00:00.000Z",
      "discovered",
      "2026-04-29T09:00:00.000Z",
      "2026-04-29T09:00:00.000Z",
    );
    insert.run(
      "s2",
      "user-1",
      "ext-2",
      "msg-2",
      "2026-04-29T10:00:00.000Z",
      "queued_for_parse",
      "2026-04-29T10:00:00.000Z",
      "2026-04-29T10:00:00.000Z",
    );
    insert.run(
      "s3",
      "user-1",
      "ext-3",
      "msg-3",
      "2026-04-29T11:00:00.000Z",
      "skipped_duplicate",
      "2026-04-29T11:00:00.000Z",
      "2026-04-29T11:00:00.000Z",
    );

    const migrationSql = readFileSync(
      join(__dirname, "009_bank_statement_status_canonicalization.sql"),
      "utf-8",
    );
    db.exec(migrationSql);

    const statuses = db
      .prepare("SELECT id, status FROM bank_statements ORDER BY id")
      .all() as Array<{ id: string; status: string }>;

    expect(statuses).toEqual([
      { id: "s1", status: "discovered" },
      { id: "s2", status: "discovered" },
      { id: "s3", status: "discovered" },
    ]);

    expect(() => {
      db.prepare(
        "INSERT INTO bank_statements (id, user_id, source, external_id, message_id, sender, sender_domain, subject, received_at, status, detection_rule_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "legacy-insert",
        "user-1",
        "gmail",
        "legacy-ext",
        "legacy-msg",
        "alerts@chase.com",
        "chase.com",
        "Legacy",
        "2026-04-29T12:00:00.000Z",
        "queued_for_parse",
        "fin-001a-v1",
        "2026-04-29T12:00:00.000Z",
        "2026-04-29T12:00:00.000Z",
      );
    }).toThrow();

    expect(() => {
      db.prepare(
        "INSERT INTO bank_statements (id, user_id, source, external_id, message_id, sender, sender_domain, subject, received_at, status, detection_rule_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "canonical-insert",
        "user-1",
        "gmail",
        "canonical-ext",
        "canonical-msg",
        "alerts@chase.com",
        "chase.com",
        "Canonical",
        "2026-04-29T12:00:00.000Z",
        "metadata_parsed",
        "fin-001b-v1",
        "2026-04-29T12:00:00.000Z",
        "2026-04-29T12:00:00.000Z",
      );
    }).not.toThrow();
  });
});
