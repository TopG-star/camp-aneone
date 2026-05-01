import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";

import { createDatabase, runMigrations } from "../connection.js";
import { SqliteBankStatementParseRepository } from "./sqlite-bank-statement-parse.repository.js";

describe("SqliteBankStatementParseRepository", () => {
  let db: Database.Database;
  let repo: SqliteBankStatementParseRepository;

  beforeEach(() => {
    db = createDatabase(":memory:");
    runMigrations(db);

    db.prepare("INSERT INTO users (id, email) VALUES (?, ?)").run(
      "u1",
      "u1@test.com",
    );

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

    repo = new SqliteBankStatementParseRepository(db);
  });

  it("upserts metadata by statement id", () => {
    const first = repo.upsertMetadata({
      statementId: "s1",
      userId: "u1",
      accountLast4: "1234",
      statementDate: "2026-04-30",
      periodStart: "2026-04-01",
      periodEnd: "2026-04-30",
      currency: "USD",
      openingBalanceMinor: 100000,
      closingBalanceMinor: 99500,
      parserId: "chase_pdf",
      parserVersion: 1,
    });

    const second = repo.upsertMetadata({
      statementId: "s1",
      userId: "u1",
      accountLast4: "1234",
      statementDate: "2026-04-30",
      periodStart: "2026-04-01",
      periodEnd: "2026-04-30",
      currency: "USD",
      openingBalanceMinor: 100000,
      closingBalanceMinor: 98500,
      parserId: "chase_pdf",
      parserVersion: 1,
    });

    expect(second.id).toBe(first.id);
    expect(second.closingBalanceMinor).toBe(98500);

    const count = db
      .prepare(
        "SELECT COUNT(*) as count FROM bank_statement_metadata WHERE statement_id = ?",
      )
      .get("s1") as { count: number };

    expect(count.count).toBe(1);

    const fetched = repo.findMetadataByStatementId("s1", "u1");
    expect(fetched).not.toBeNull();
    expect(fetched?.closingBalanceMinor).toBe(98500);
    expect(repo.findMetadataByStatementId("s1", "missing-user")).toBeNull();
  });

  it("replaces transactions for a statement deterministically", () => {
    repo.replaceTransactions("s1", [
      {
        userId: "u1",
        postedAt: "2026-04-20",
        description: "Coffee Shop",
        amountMinor: -450,
        balanceMinor: 99100,
        dedupeKey: "2026-04-20|coffee shop|-450",
      },
      {
        userId: "u1",
        postedAt: "2026-04-21",
        description: "Salary",
        amountMinor: 250000,
        balanceMinor: 349100,
        dedupeKey: "2026-04-21|salary|250000",
      },
    ]);

    const secondPass = repo.replaceTransactions("s1", [
      {
        userId: "u1",
        postedAt: "2026-04-22",
        description: "Groceries",
        amountMinor: -9800,
        balanceMinor: 339300,
        dedupeKey: "2026-04-22|groceries|-9800",
      },
    ]);

    expect(secondPass).toHaveLength(1);

    const count = db
      .prepare(
        "SELECT COUNT(*) as count FROM bank_statement_transactions WHERE statement_id = ?",
      )
      .get("s1") as { count: number };

    expect(count.count).toBe(1);
  });

  it("records parse runs and counts failed runs by stage", () => {
    repo.recordParseRun({
      statementId: "s1",
      userId: "u1",
      stage: "metadata",
      outcome: "success",
      parserId: "chase_pdf",
      parserVersion: 1,
      errorCode: null,
      errorMessage: null,
      durationMs: 17,
    });

    repo.recordParseRun({
      statementId: "s1",
      userId: "u1",
      stage: "transactions",
      outcome: "error",
      parserId: "chase_pdf",
      parserVersion: 1,
      errorCode: "TRANSACTION_PARSE_FAILED",
      errorMessage: "line parse failure",
      durationMs: 21,
    });

    repo.recordParseRun({
      statementId: "s1",
      userId: "u1",
      stage: "transactions",
      outcome: "error",
      parserId: "chase_pdf",
      parserVersion: 1,
      errorCode: "TRANSACTION_PARSE_FAILED",
      errorMessage: "line parse failure",
      durationMs: 23,
    });

    expect(repo.countFailedRuns("s1", "metadata")).toBe(0);
    expect(repo.countFailedRuns("s1", "transactions")).toBe(2);
  });

  it("queries transactions with statement, date, and text filters", () => {
    repo.replaceTransactions("s1", [
      {
        userId: "u1",
        postedAt: "2026-04-20",
        description: "Coffee Shop",
        amountMinor: -450,
        balanceMinor: 99100,
        dedupeKey: "2026-04-20|coffee shop|-450",
      },
      {
        userId: "u1",
        postedAt: "2026-04-21",
        description: "Salary",
        amountMinor: 250000,
        balanceMinor: 349100,
        dedupeKey: "2026-04-21|salary|250000",
      },
      {
        userId: "u1",
        postedAt: "2026-03-31",
        description: "Older Charge",
        amountMinor: -1200,
        balanceMinor: 98000,
        dedupeKey: "2026-03-31|older charge|-1200",
      },
    ]);

    const filtered = repo.findTransactions({
      userId: "u1",
      statementId: "s1",
      searchText: "coffee",
      postedAtFrom: "2026-04-01",
      postedAtTo: "2026-04-30",
      limit: 10,
    });

    expect(filtered).toHaveLength(1);
    expect(filtered[0].description).toBe("Coffee Shop");

    const latestTwo = repo.findTransactions({
      userId: "u1",
      limit: 2,
    });

    expect(latestTwo).toHaveLength(2);
    expect(latestTwo[0].postedAt >= latestTwo[1].postedAt).toBe(true);
  });

  it("returns parse runs newest first with user scoping", () => {
    repo.recordParseRun({
      statementId: "s1",
      userId: "u1",
      stage: "metadata",
      outcome: "success",
      parserId: "chase_pdf",
      parserVersion: 1,
      errorCode: null,
      errorMessage: null,
      durationMs: 15,
    });
    repo.recordParseRun({
      statementId: "s1",
      userId: "u1",
      stage: "transactions",
      outcome: "success",
      parserId: "chase_pdf",
      parserVersion: 1,
      errorCode: null,
      errorMessage: null,
      durationMs: 26,
    });

    const runs = repo.findParseRuns({
      statementId: "s1",
      userId: "u1",
      limit: 10,
    });

    expect(runs).toHaveLength(2);
    expect(runs[0].createdAt >= runs[1].createdAt).toBe(true);

    const none = repo.findParseRuns({
      statementId: "s1",
      userId: "missing-user",
      limit: 10,
    });
    expect(none).toHaveLength(0);
  });
});
