import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";

import { createDatabase, runMigrations } from "../connection.js";
import { SqliteBankStatementRepository } from "./sqlite-bank-statement.repository.js";

describe("SqliteBankStatementRepository", () => {
  let db: Database.Database;
  let repo: SqliteBankStatementRepository;

  beforeEach(() => {
    db = createDatabase(":memory:");
    runMigrations(db);
    db
      .prepare("INSERT INTO users (id, email) VALUES (?, ?)")
      .run("user-1", "user-1@example.com");
    repo = new SqliteBankStatementRepository(db);
  });

  it("upserts a discovered candidate and retrieves by source+external id", () => {
    const created = repo.upsert({
      userId: "user-1",
      source: "gmail",
      externalId: "msg-1",
      messageId: "msg-1",
      threadId: "thread-1",
      sender: "alerts@chase.com",
      senderDomain: "chase.com",
      subject: "Your monthly statement is ready",
      receivedAt: "2026-04-29T09:00:00Z",
      status: "discovered",
      detectionRuleVersion: "fin-001a-v1",
    });

    expect(created.id).toBeTruthy();
    expect(created.status).toBe("discovered");

    const found = repo.findBySourceAndExternalId("gmail", "msg-1", "user-1");
    expect(found).not.toBeNull();
    expect(found?.id).toBe(created.id);
    expect(found?.senderDomain).toBe("chase.com");
  });

  it("is idempotent on (user_id, source, external_id)", () => {
    const first = repo.upsert({
      userId: "user-1",
      source: "gmail",
      externalId: "msg-dup",
      messageId: "msg-dup",
      threadId: "thread-1",
      sender: "alerts@chase.com",
      senderDomain: "chase.com",
      subject: "Statement #1",
      receivedAt: "2026-04-29T09:00:00Z",
      status: "discovered",
      detectionRuleVersion: "fin-001a-v1",
    });

    const second = repo.upsert({
      userId: "user-1",
      source: "gmail",
      externalId: "msg-dup",
      messageId: "msg-dup",
      threadId: "thread-1",
      sender: "alerts@chase.com",
      senderDomain: "chase.com",
      subject: "Statement #1 updated",
      receivedAt: "2026-04-29T09:00:00Z",
      status: "discovered",
      detectionRuleVersion: "fin-001a-v1",
    });

    expect(second.id).toBe(first.id);

    const count = db
      .prepare("SELECT COUNT(*) as count FROM bank_statements WHERE user_id = ? AND source = ? AND external_id = ?")
      .get("user-1", "gmail", "msg-dup") as { count: number };

    expect(count.count).toBe(1);
    expect(second.subject).toBe("Statement #1 updated");
  });

  it("supports deterministic status transitions", () => {
    const created = repo.upsert({
      userId: "user-1",
      source: "gmail",
      externalId: "msg-transition",
      messageId: "msg-transition",
      threadId: "thread-1",
      sender: "alerts@chase.com",
      senderDomain: "chase.com",
      subject: "Monthly statement",
      receivedAt: "2026-04-29T09:00:00Z",
      status: "discovered",
      detectionRuleVersion: "fin-001a-v1",
    });

    repo.markQueuedForParse(created.id);
    const queued = repo.findById(created.id);
    expect(queued?.status).toBe("queued_for_parse");

    repo.markSkippedDuplicate(created.id);
    const skipped = repo.findById(created.id);
    expect(skipped?.status).toBe("skipped_duplicate");
  });
});
