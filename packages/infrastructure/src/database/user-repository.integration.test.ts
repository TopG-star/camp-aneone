import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach } from "vitest";
import { SqliteUserRepository } from "./repositories/sqlite-user.repository.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const migrationsDir = join(__dirname, "migrations");
  for (const file of [
    "001_initial_schema.sql",
    "002_add_thread_id_labels.sql",
    "003_add_classify_attempts.sql",
    "004_add_conversation_id.sql",
    "005_users_and_oauth_tokens.sql",
  ]) {
    db.exec(readFileSync(join(migrationsDir, file), "utf-8"));
  }

  return db;
}

describe("SqliteUserRepository", () => {
  let db: Database.Database;
  let repo: SqliteUserRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteUserRepository(db);
  });

  it("upsert creates a user and findById retrieves it", () => {
    const user = repo.upsert({ id: "u1", email: "alice@test.com" });

    expect(user.id).toBe("u1");
    expect(user.email).toBe("alice@test.com");
    expect(user.createdAt).toBeTruthy();

    const found = repo.findById("u1");
    expect(found).toEqual(user);
  });

  it("upsert updates email on conflict", () => {
    repo.upsert({ id: "u1", email: "old@test.com" });
    const updated = repo.upsert({ id: "u1", email: "new@test.com" });

    expect(updated.email).toBe("new@test.com");
    expect(repo.findById("u1")!.email).toBe("new@test.com");
  });

  it("findByEmail returns user", () => {
    repo.upsert({ id: "u1", email: "alice@test.com" });

    const found = repo.findByEmail("alice@test.com");
    expect(found).not.toBeNull();
    expect(found!.id).toBe("u1");
  });

  it("findByEmail returns null for unknown email", () => {
    expect(repo.findByEmail("nobody@test.com")).toBeNull();
  });

  it("findById returns null for unknown id", () => {
    expect(repo.findById("nonexistent")).toBeNull();
  });

  it("list returns all users ordered by created_at", () => {
    repo.upsert({ id: "u1", email: "alice@test.com" });
    repo.upsert({ id: "u2", email: "bob@test.com" });

    const users = repo.list();
    expect(users).toHaveLength(2);
    expect(users[0].email).toBe("alice@test.com");
    expect(users[1].email).toBe("bob@test.com");
  });

  it("delete removes user", () => {
    repo.upsert({ id: "u1", email: "alice@test.com" });
    repo.delete("u1");

    expect(repo.findById("u1")).toBeNull();
  });

  it("rejects duplicate email on different user id", () => {
    repo.upsert({ id: "u1", email: "alice@test.com" });

    expect(() => repo.upsert({ id: "u2", email: "alice@test.com" })).toThrow();
  });
});
