import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createDatabase } from "../connection.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("Migration 011 push subscriptions user scope", () => {
  it("adds user_id column and preserves existing rows", () => {
    const db = createDatabase(":memory:");

    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE TABLE push_subscriptions (
        id TEXT PRIMARY KEY,
        endpoint TEXT NOT NULL UNIQUE,
        keys_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `);

    db.prepare("INSERT INTO users (id, email) VALUES (?, ?)").run("user-1", "user-1@example.com");
    db.prepare(
      "INSERT INTO push_subscriptions (id, endpoint, keys_json, created_at) VALUES (?, ?, ?, ?)",
    ).run(
      "sub-1",
      "https://example.com/push/sub-1",
      JSON.stringify({ p256dh: "k1", auth: "a1" }),
      "2026-05-01T00:00:00.000Z",
    );

    const migrationSql = readFileSync(
      join(__dirname, "011_push_subscriptions_user_scope.sql"),
      "utf-8",
    );

    db.exec(migrationSql);

    const columns = db
      .prepare("PRAGMA table_info(push_subscriptions)")
      .all() as Array<{ name: string }>;

    expect(columns.map((column) => column.name)).toContain("user_id");

    const row = db
      .prepare(
        "SELECT id, endpoint, keys_json, user_id FROM push_subscriptions WHERE id = ?",
      )
      .get("sub-1") as {
      id: string;
      endpoint: string;
      keys_json: string;
      user_id: string | null;
    };

    expect(row.id).toBe("sub-1");
    expect(row.endpoint).toBe("https://example.com/push/sub-1");
    expect(row.keys_json).toBe(JSON.stringify({ p256dh: "k1", auth: "a1" }));
    expect(row.user_id).toBeNull();
  });
});
