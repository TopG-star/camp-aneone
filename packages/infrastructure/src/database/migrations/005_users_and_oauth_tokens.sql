-- Migration 005: Users and OAuth tokens
-- Adds minimal user tracking + encrypted token storage for multi-account support.

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  provider           TEXT NOT NULL CHECK (provider IN ('google', 'github')),
  user_id            TEXT NOT NULL,
  access_token       TEXT NOT NULL,
  access_token_iv    TEXT NOT NULL,
  access_token_tag   TEXT NOT NULL,
  refresh_token      TEXT,
  refresh_token_iv   TEXT,
  refresh_token_tag  TEXT,
  token_type         TEXT NOT NULL DEFAULT 'bearer',
  scope              TEXT NOT NULL DEFAULT '',
  expires_at         TEXT,
  provider_email     TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (provider, user_id),
  FOREIGN KEY (user_id) REFERENCES users (id)
);
