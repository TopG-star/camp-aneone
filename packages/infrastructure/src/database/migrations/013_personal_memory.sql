-- Migration 013: Personal memory notes and pins (RAG v1 foundation)

CREATE TABLE IF NOT EXISTS personal_memory_notes (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id),
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  tags        TEXT NOT NULL DEFAULT '[]',
  pinned      INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_personal_memory_notes_user_id
  ON personal_memory_notes (user_id);

CREATE INDEX IF NOT EXISTS idx_personal_memory_notes_user_updated_at
  ON personal_memory_notes (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS personal_memory_pins (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users (id),
  source_message_id TEXT,
  conversation_id   TEXT,
  content           TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_personal_memory_pins_user_source_message
  ON personal_memory_pins (user_id, source_message_id)
  WHERE source_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_personal_memory_pins_user_created_at
  ON personal_memory_pins (user_id, created_at DESC);
