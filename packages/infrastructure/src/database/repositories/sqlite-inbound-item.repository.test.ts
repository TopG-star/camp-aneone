import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";

import { createDatabase, runMigrations } from "../connection.js";
import { SqliteInboundItemRepository } from "./sqlite-inbound-item.repository.js";

describe("SqliteInboundItemRepository user-scoped idempotency", () => {
  let db: Database.Database;
  let repo: SqliteInboundItemRepository;

  beforeEach(() => {
    db = createDatabase(":memory:");
    runMigrations(db);
    db.prepare("INSERT INTO users (id, email) VALUES (?, ?)").run("user-A", "a@example.com");
    db.prepare("INSERT INTO users (id, email) VALUES (?, ?)").run("user-B", "b@example.com");
    repo = new SqliteInboundItemRepository(db);
  });

  it("stores separate inbound items per user for the same source+external id", () => {
    const itemA = repo.upsert({
      userId: "user-A",
      source: "teams",
      externalId: "teams-message-1",
      from: "alice@company.com",
      subject: "Standup",
      bodyPreview: "A",
      receivedAt: "2026-05-05T10:00:00Z",
      rawJson: "{}",
      threadId: null,
      labels: "[]",
      classifiedAt: null,
      classifyAttempts: 0,
    });

    const itemB = repo.upsert({
      userId: "user-B",
      source: "teams",
      externalId: "teams-message-1",
      from: "bob@company.com",
      subject: "Standup",
      bodyPreview: "B",
      receivedAt: "2026-05-05T10:00:00Z",
      rawJson: "{}",
      threadId: null,
      labels: "[]",
      classifiedAt: null,
      classifyAttempts: 0,
    });

    expect(itemA.id).not.toBe(itemB.id);

    const foundA = repo.findBySourceAndExternalId("teams", "teams-message-1", "user-A");
    const foundB = repo.findBySourceAndExternalId("teams", "teams-message-1", "user-B");

    expect(foundA?.id).toBe(itemA.id);
    expect(foundB?.id).toBe(itemB.id);

    const count = db
      .prepare(
        "SELECT COUNT(*) as count FROM inbound_items WHERE source = ? AND external_id = ?",
      )
      .get("teams", "teams-message-1") as { count: number };

    expect(count.count).toBe(2);
  });
});
