import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createDatabase } from "../connection.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("Migration 010 bank statement parser framework", () => {
  it("creates parse metadata, transactions, and runs tables", () => {
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
        status                  TEXT NOT NULL
          CHECK (status IN ('discovered', 'metadata_parsed', 'error_metadata', 'transactions_parsed', 'error_transactions')),
        detection_rule_version  TEXT NOT NULL,
        created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE (user_id, source, external_id)
      );
    `);

    db.prepare("INSERT INTO users (id, email) VALUES (?, ?)").run("u1", "u1@test.com");
    db.prepare(`
      INSERT INTO bank_statements (
        id, user_id, source, external_id, message_id, thread_id,
        sender, sender_domain, subject, received_at, status,
        detection_rule_version, created_at, updated_at
      ) VALUES (?, ?, 'gmail', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "s1",
      "u1",
      "ext-s1",
      "msg-s1",
      "thread-s1",
      "alerts@chase.com",
      "chase.com",
      "Statement",
      "2026-05-01T09:00:00.000Z",
      "discovered",
      "fin-001c-v1",
      "2026-05-01T09:00:00.000Z",
      "2026-05-01T09:00:00.000Z",
    );

    const migrationSql = readFileSync(
      join(__dirname, "010_bank_statement_parser_framework.sql"),
      "utf-8",
    );

    db.exec(migrationSql);

    const metadataColumns = db
      .prepare("PRAGMA table_info(bank_statement_metadata)")
      .all() as Array<{ name: string }>;
    const transactionColumns = db
      .prepare("PRAGMA table_info(bank_statement_transactions)")
      .all() as Array<{ name: string }>;
    const parseRunColumns = db
      .prepare("PRAGMA table_info(bank_statement_parse_runs)")
      .all() as Array<{ name: string }>;

    expect(metadataColumns.map((col) => col.name)).toEqual(
      expect.arrayContaining([
        "id",
        "statement_id",
        "user_id",
        "account_last4",
        "statement_date",
        "period_start",
        "period_end",
        "currency",
        "opening_balance_minor",
        "closing_balance_minor",
        "parser_id",
        "parser_version",
        "created_at",
        "updated_at",
      ]),
    );

    expect(transactionColumns.map((col) => col.name)).toEqual(
      expect.arrayContaining([
        "id",
        "statement_id",
        "user_id",
        "posted_at",
        "description",
        "amount_minor",
        "balance_minor",
        "dedupe_key",
        "created_at",
      ]),
    );

    expect(parseRunColumns.map((col) => col.name)).toEqual(
      expect.arrayContaining([
        "id",
        "statement_id",
        "user_id",
        "stage",
        "outcome",
        "parser_id",
        "parser_version",
        "error_code",
        "error_message",
        "duration_ms",
        "created_at",
      ]),
    );

    expect(() => {
      db.prepare(`
        INSERT INTO bank_statement_metadata (
          id, statement_id, user_id, account_last4, statement_date,
          period_start, period_end, currency, opening_balance_minor,
          closing_balance_minor, parser_id, parser_version,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "m-missing",
        "missing-statement",
        "u1",
        "1234",
        "2026-04-30",
        "2026-04-01",
        "2026-04-30",
        "USD",
        100000,
        99500,
        "chase_pdf",
        1,
        "2026-05-01T09:00:00.000Z",
        "2026-05-01T09:00:00.000Z",
      );
    }).toThrow();
  });
});
