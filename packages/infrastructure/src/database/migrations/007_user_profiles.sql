-- Migration 007: User profiles for assistant personalization
-- Adds per-user profile settings (salutation, style, timezone).

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id              TEXT PRIMARY KEY,
  preferred_name       TEXT,
  nickname             TEXT,
  salutation_mode      TEXT NOT NULL DEFAULT 'sir_with_name'
    CHECK (salutation_mode IN ('sir', 'sir_with_name', 'nickname')),
  communication_style  TEXT NOT NULL DEFAULT 'friendly'
    CHECK (communication_style IN ('formal', 'friendly', 'concise', 'technical')),
  timezone             TEXT NOT NULL DEFAULT 'UTC',
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (user_id) REFERENCES users (id)
);