import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach } from "vitest";
import { SqliteUserRepository } from "./repositories/sqlite-user.repository.js";
import { SqliteOAuthTokenRepository } from "./repositories/sqlite-oauth-token.repository.js";
import { TokenCipher } from "../crypto/token-cipher.js";
import type { OAuthToken } from "@oneon/domain";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ENCRYPTION_KEY = "test-encryption-key-must-be-at-least-32-chars-long!!";

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

function makeGoogleToken(userId: string): OAuthToken {
  return {
    provider: "google",
    userId,
    accessToken: "ya29.access-token-value",
    refreshToken: "1//refresh-token-value",
    tokenType: "bearer",
    scope: "openid email https://www.googleapis.com/auth/gmail.readonly",
    expiresAt: "2026-04-20T00:00:00.000Z",
    providerEmail: "alice@gmail.com",
    createdAt: "",
    updatedAt: "",
  };
}

function makeGitHubToken(userId: string): OAuthToken {
  return {
    provider: "github",
    userId,
    accessToken: "ghp_abcdef1234567890",
    refreshToken: null,
    tokenType: "bearer",
    scope: "",
    expiresAt: null,
    providerEmail: "alice@github.com",
    createdAt: "",
    updatedAt: "",
  };
}

describe("SqliteOAuthTokenRepository", () => {
  let db: Database.Database;
  let userRepo: SqliteUserRepository;
  let repo: SqliteOAuthTokenRepository;
  let cipher: TokenCipher;

  beforeEach(() => {
    db = createTestDb();
    cipher = new TokenCipher(ENCRYPTION_KEY);
    userRepo = new SqliteUserRepository(db);
    repo = new SqliteOAuthTokenRepository(db, cipher);

    // Create test users (FK requirement)
    userRepo.upsert({ id: "u1", email: "alice@test.com" });
    userRepo.upsert({ id: "u2", email: "bob@test.com" });
  });

  it("upsert stores and get retrieves a Google token", () => {
    const token = makeGoogleToken("u1");
    repo.upsert(token);

    const found = repo.get("google", "u1");
    expect(found).not.toBeNull();
    expect(found!.provider).toBe("google");
    expect(found!.userId).toBe("u1");
    expect(found!.accessToken).toBe("ya29.access-token-value");
    expect(found!.refreshToken).toBe("1//refresh-token-value");
    expect(found!.scope).toBe("openid email https://www.googleapis.com/auth/gmail.readonly");
    expect(found!.expiresAt).toBe("2026-04-20T00:00:00.000Z");
    expect(found!.providerEmail).toBe("alice@gmail.com");
    expect(found!.createdAt).toBeTruthy();
    expect(found!.updatedAt).toBeTruthy();
  });

  it("stores tokens encrypted in raw DB rows", () => {
    repo.upsert(makeGoogleToken("u1"));

    const raw = db
      .prepare("SELECT access_token, refresh_token FROM oauth_tokens WHERE provider = 'google' AND user_id = 'u1'")
      .get() as { access_token: string; refresh_token: string };

    // Raw values should NOT be plaintext
    expect(raw.access_token).not.toBe("ya29.access-token-value");
    expect(raw.refresh_token).not.toBe("1//refresh-token-value");

    // Should be hex-encoded
    expect(raw.access_token).toMatch(/^[0-9a-f]+$/);
    expect(raw.refresh_token).toMatch(/^[0-9a-f]+$/);
  });

  it("upsert stores GitHub PAT with null refresh token", () => {
    const token = makeGitHubToken("u1");
    repo.upsert(token);

    const found = repo.get("github", "u1");
    expect(found).not.toBeNull();
    expect(found!.accessToken).toBe("ghp_abcdef1234567890");
    expect(found!.refreshToken).toBeNull();
    expect(found!.expiresAt).toBeNull();

    // Raw DB should have null refresh columns
    const raw = db
      .prepare("SELECT refresh_token, refresh_token_iv, refresh_token_tag FROM oauth_tokens WHERE provider = 'github' AND user_id = 'u1'")
      .get() as { refresh_token: string | null; refresh_token_iv: string | null; refresh_token_tag: string | null };

    expect(raw.refresh_token).toBeNull();
    expect(raw.refresh_token_iv).toBeNull();
    expect(raw.refresh_token_tag).toBeNull();
  });

  it("upsert updates existing token on conflict", () => {
    repo.upsert(makeGoogleToken("u1"));
    const updated: OAuthToken = {
      ...makeGoogleToken("u1"),
      accessToken: "ya29.new-access-token",
      scope: "openid email calendar",
    };
    repo.upsert(updated);

    const found = repo.get("google", "u1");
    expect(found!.accessToken).toBe("ya29.new-access-token");
    expect(found!.scope).toBe("openid email calendar");
    // Refresh token preserved from update
    expect(found!.refreshToken).toBe("1//refresh-token-value");
  });

  it("get returns null for unknown provider/user", () => {
    expect(repo.get("google", "u1")).toBeNull();
    expect(repo.get("github", "nonexistent")).toBeNull();
  });

  it("delete removes token", () => {
    repo.upsert(makeGoogleToken("u1"));
    repo.delete("google", "u1");

    expect(repo.get("google", "u1")).toBeNull();
  });

  it("listByUser returns all tokens for a user", () => {
    repo.upsert(makeGoogleToken("u1"));
    repo.upsert(makeGitHubToken("u1"));

    const tokens = repo.listByUser("u1");
    expect(tokens).toHaveLength(2);
    expect(tokens.map((t) => t.provider).sort()).toEqual(["github", "google"]);
  });

  it("listByUser returns empty array for user with no tokens", () => {
    expect(repo.listByUser("u2")).toEqual([]);
  });

  it("isolates tokens between users", () => {
    repo.upsert(makeGoogleToken("u1"));
    repo.upsert({ ...makeGoogleToken("u2"), providerEmail: "bob@gmail.com" });

    const u1Token = repo.get("google", "u1");
    const u2Token = repo.get("google", "u2");

    expect(u1Token!.providerEmail).toBe("alice@gmail.com");
    expect(u2Token!.providerEmail).toBe("bob@gmail.com");
  });

  it("returns null with wrong encryption key (graceful decrypt failure)", () => {
    repo.upsert(makeGoogleToken("u1"));

    const wrongCipher = new TokenCipher("wrong-key-also-must-be-at-least-32-characters!!");
    const wrongRepo = new SqliteOAuthTokenRepository(db, wrongCipher);

    expect(wrongRepo.get("google", "u1")).toBeNull();
  });
});
