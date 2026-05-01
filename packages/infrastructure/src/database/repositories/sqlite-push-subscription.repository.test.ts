import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";

import { createDatabase, runMigrations } from "../connection.js";
import { SqlitePushSubscriptionRepository } from "./sqlite-push-subscription.repository.js";

describe("SqlitePushSubscriptionRepository", () => {
  let db: Database.Database;
  let repo: SqlitePushSubscriptionRepository;

  beforeEach(() => {
    db = createDatabase(":memory:");
    runMigrations(db);
    db.prepare("INSERT INTO users (id, email) VALUES (?, ?)").run("user-A", "a@example.com");
    db.prepare("INSERT INTO users (id, email) VALUES (?, ?)").run("user-B", "b@example.com");
    repo = new SqlitePushSubscriptionRepository(db);
  });

  it("upserts a push subscription", () => {
    const created = repo.upsert({
      endpoint: "https://example.com/push/sub-1",
      keysJson: JSON.stringify({ p256dh: "k1", auth: "a1" }),
      userId: "user-A",
    });

    expect(created.id).toBeTruthy();
    expect(created.userId).toBe("user-A");
  });

  it("updates existing endpoint and keeps unique row", () => {
    const first = repo.upsert({
      endpoint: "https://example.com/push/sub-1",
      keysJson: JSON.stringify({ p256dh: "k1", auth: "a1" }),
      userId: "user-A",
    });

    const second = repo.upsert({
      endpoint: "https://example.com/push/sub-1",
      keysJson: JSON.stringify({ p256dh: "k2", auth: "a2" }),
      userId: "user-A",
    });

    expect(second.id).toBe(first.id);

    const count = db
      .prepare("SELECT COUNT(*) as count FROM push_subscriptions WHERE endpoint = ?")
      .get("https://example.com/push/sub-1") as { count: number };

    expect(count.count).toBe(1);
    expect(second.keysJson).toBe(JSON.stringify({ p256dh: "k2", auth: "a2" }));
  });

  it("finds subscriptions by user", () => {
    repo.upsert({
      endpoint: "https://example.com/push/a-1",
      keysJson: JSON.stringify({ p256dh: "k1", auth: "a1" }),
      userId: "user-A",
    });
    repo.upsert({
      endpoint: "https://example.com/push/a-2",
      keysJson: JSON.stringify({ p256dh: "k2", auth: "a2" }),
      userId: "user-A",
    });
    repo.upsert({
      endpoint: "https://example.com/push/b-1",
      keysJson: JSON.stringify({ p256dh: "k3", auth: "a3" }),
      userId: "user-B",
    });

    const userASubs = repo.findByUserId("user-A");

    expect(userASubs).toHaveLength(2);
    expect(userASubs.every((subscription) => subscription.userId === "user-A")).toBe(true);
  });

  it("deletes by endpoint scoped to user", () => {
    repo.upsert({
      endpoint: "https://example.com/push/shared",
      keysJson: JSON.stringify({ p256dh: "k1", auth: "a1" }),
      userId: "user-A",
    });

    repo.deleteByEndpoint("https://example.com/push/shared", "user-B");
    expect(repo.findByUserId("user-A")).toHaveLength(1);

    repo.deleteByEndpoint("https://example.com/push/shared", "user-A");
    expect(repo.findByUserId("user-A")).toHaveLength(0);
  });
});
