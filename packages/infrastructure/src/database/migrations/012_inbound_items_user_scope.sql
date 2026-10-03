-- Migration 012: Inbound item user-scoped idempotency
-- Align inbound item uniqueness with per-user ingestion semantics while
-- preserving legacy null-user idempotency behavior.

PRAGMA foreign_keys = OFF;

CREATE TABLE inbound_items_new (
  id            TEXT PRIMARY KEY,
  source        TEXT NOT NULL CHECK (source IN ('gmail', 'outlook', 'teams', 'github')),
  external_id   TEXT NOT NULL,
  "from"        TEXT NOT NULL,
  subject       TEXT NOT NULL DEFAULT '',
  body_preview  TEXT NOT NULL DEFAULT '',
  received_at   TEXT NOT NULL,
  raw_json      TEXT NOT NULL DEFAULT '{}',
  classified_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  thread_id     TEXT,
  labels        TEXT NOT NULL DEFAULT '[]',
  classify_attempts INTEGER NOT NULL DEFAULT 0,
  user_id       TEXT REFERENCES users (id)
);

INSERT INTO inbound_items_new (
  id,
  source,
  external_id,
  "from",
  subject,
  body_preview,
  received_at,
  raw_json,
  classified_at,
  created_at,
  updated_at,
  thread_id,
  labels,
  classify_attempts,
  user_id
)
SELECT
  id,
  source,
  external_id,
  "from",
  subject,
  body_preview,
  received_at,
  raw_json,
  classified_at,
  created_at,
  updated_at,
  thread_id,
  labels,
  classify_attempts,
  user_id
FROM inbound_items;

DROP TABLE inbound_items;

ALTER TABLE inbound_items_new RENAME TO inbound_items;

CREATE INDEX IF NOT EXISTS idx_inbound_items_source ON inbound_items (source);
CREATE INDEX IF NOT EXISTS idx_inbound_items_received_at ON inbound_items (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_inbound_items_classified_at ON inbound_items (classified_at);
CREATE INDEX IF NOT EXISTS idx_inbound_items_user_id ON inbound_items (user_id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_inbound_items_user_source_external
  ON inbound_items (user_id, source, external_id)
  WHERE user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_inbound_items_null_user_source_external
  ON inbound_items (source, external_id)
  WHERE user_id IS NULL;

PRAGMA foreign_keys = ON;
