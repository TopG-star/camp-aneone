import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach } from "vitest";
import { SqliteUserRepository } from "./repositories/sqlite-user.repository.js";
import { SqliteUserProfileRepository } from "./repositories/sqlite-user-profile.repository.js";

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
    "006_add_user_id_to_core_tables.sql",
    "007_user_profiles.sql",
  ]) {
    db.exec(readFileSync(join(migrationsDir, file), "utf-8"));
  }

  return db;
}

describe("SqliteUserProfileRepository", () => {
  let db: Database.Database;
  let userRepo: SqliteUserRepository;
  let repo: SqliteUserProfileRepository;

  beforeEach(() => {
    db = createTestDb();
    userRepo = new SqliteUserRepository(db);
    repo = new SqliteUserProfileRepository(db);

    userRepo.upsert({ id: "u1", email: "alice@test.com" });
    userRepo.upsert({ id: "u2", email: "bob@test.com" });
  });

  it("upsert creates a profile and findByUserId retrieves it", () => {
    const profile = repo.upsert({
      userId: "u1",
      preferredName: "Alice",
      nickname: "Ace",
      salutationMode: "sir_with_name",
      communicationStyle: "friendly",
      timezone: "Africa/Lagos",
    });

    expect(profile.userId).toBe("u1");
    expect(profile.preferredName).toBe("Alice");
    expect(profile.nickname).toBe("Ace");
    expect(profile.salutationMode).toBe("sir_with_name");
    expect(profile.communicationStyle).toBe("friendly");
    expect(profile.timezone).toBe("Africa/Lagos");
    expect(profile.createdAt).toBeTruthy();
    expect(profile.updatedAt).toBeTruthy();

    const found = repo.findByUserId("u1");
    expect(found).toEqual(profile);
  });

  it("upsert applies defaults when optional fields are omitted", () => {
    const profile = repo.upsert({
      userId: "u1",
      preferredName: null,
      nickname: null,
    });

    expect(profile.preferredName).toBeNull();
    expect(profile.nickname).toBeNull();
    expect(profile.salutationMode).toBe("sir_with_name");
    expect(profile.communicationStyle).toBe("friendly");
    expect(profile.timezone).toBe("UTC");
  });

  it("upsert updates an existing profile", () => {
    repo.upsert({
      userId: "u1",
      preferredName: "Alice",
      nickname: "Ace",
      salutationMode: "sir_with_name",
      communicationStyle: "friendly",
      timezone: "UTC",
    });

    const updated = repo.upsert({
      userId: "u1",
      preferredName: "Alicia",
      nickname: "Lia",
      salutationMode: "nickname",
      communicationStyle: "concise",
      timezone: "Europe/London",
    });

    expect(updated.preferredName).toBe("Alicia");
    expect(updated.nickname).toBe("Lia");
    expect(updated.salutationMode).toBe("nickname");
    expect(updated.communicationStyle).toBe("concise");
    expect(updated.timezone).toBe("Europe/London");
  });

  it("findByUserId returns null when no profile exists", () => {
    expect(repo.findByUserId("u2")).toBeNull();
  });

  it("deleteByUserId removes an existing profile", () => {
    repo.upsert({
      userId: "u1",
      preferredName: "Alice",
      nickname: null,
    });

    repo.deleteByUserId("u1");
    expect(repo.findByUserId("u1")).toBeNull();
  });

  it("enforces foreign key to existing users", () => {
    expect(() =>
      repo.upsert({
        userId: "missing-user",
        preferredName: "Ghost",
        nickname: null,
      })
    ).toThrow();
  });
});