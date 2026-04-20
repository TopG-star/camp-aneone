-- Camp-Aneone v1 Schema Migration
-- Date: 2026-04-14
-- SQLite with WAL mode, strict foreign keys

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ── Inbound Items ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inbound_items (
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
  UNIQUE (source, external_id)
);

CREATE INDEX IF NOT EXISTS idx_inbound_items_source ON inbound_items (source);
CREATE INDEX IF NOT EXISTS idx_inbound_items_received_at ON inbound_items (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_inbound_items_classified_at ON inbound_items (classified_at);

-- ── Classifications ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS classifications (
  id               TEXT PRIMARY KEY,
  inbound_item_id  TEXT NOT NULL UNIQUE,
  category         TEXT NOT NULL CHECK (category IN ('urgent', 'work', 'personal', 'newsletter', 'transactional', 'spam')),
  priority         INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 5),
  summary          TEXT NOT NULL DEFAULT '',
  action_items     TEXT NOT NULL DEFAULT '[]',
  follow_up_needed INTEGER NOT NULL DEFAULT 0,
  model            TEXT NOT NULL,
  prompt_version   TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (inbound_item_id) REFERENCES inbound_items (id)
);

CREATE INDEX IF NOT EXISTS idx_classifications_category ON classifications (category);
CREATE INDEX IF NOT EXISTS idx_classifications_priority ON classifications (priority);
CREATE INDEX IF NOT EXISTS idx_classifications_follow_up ON classifications (follow_up_needed) WHERE follow_up_needed = 1;

-- ── Deadlines ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS deadlines (
  id              TEXT PRIMARY KEY,
  inbound_item_id TEXT NOT NULL,
  due_date        TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  confidence      REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dismissed')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (inbound_item_id) REFERENCES inbound_items (id)
);

CREATE INDEX IF NOT EXISTS idx_deadlines_due_date ON deadlines (due_date);
CREATE INDEX IF NOT EXISTS idx_deadlines_status ON deadlines (status);

-- ── Action Log (append-only) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS action_log (
  id            TEXT PRIMARY KEY,
  resource_id   TEXT NOT NULL,
  action_type   TEXT NOT NULL CHECK (action_type IN ('archive', 'delete', 'draft_reply', 'send', 'forward', 'create_reminder', 'notify', 'classify', 'label')),
  risk_level    TEXT NOT NULL CHECK (risk_level IN ('auto', 'approval_required')),
  status        TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'executed', 'rejected', 'rolled_back')),
  payload_json  TEXT NOT NULL DEFAULT '{}',
  result_json   TEXT,
  error_json    TEXT,
  rollback_json TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_action_log_resource ON action_log (resource_id, action_type);
CREATE INDEX IF NOT EXISTS idx_action_log_status ON action_log (status);

-- ── Notifications ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY,
  event_type  TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  deep_link   TEXT,
  read        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications (read) WHERE read = 0;
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications (created_at DESC);

-- ── Conversations (append-only) ──────────────────────────────
CREATE TABLE IF NOT EXISTS conversations (
  id          TEXT PRIMARY KEY,
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content     TEXT NOT NULL,
  tool_calls  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_conversations_created_at ON conversations (created_at DESC);

-- ── Preferences (key-value) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS preferences (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ── Push Subscriptions (MVP1.5 foundation) ───────────────────
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         TEXT PRIMARY KEY,
  endpoint   TEXT NOT NULL UNIQUE,
  keys_json  TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ── Classification Feedback ──────────────────────────────────
CREATE TABLE IF NOT EXISTS classification_feedback (
  id                  TEXT PRIMARY KEY,
  classification_id   TEXT NOT NULL,
  corrected_category  TEXT CHECK (corrected_category IS NULL OR corrected_category IN ('urgent', 'work', 'personal', 'newsletter', 'transactional', 'spam')),
  corrected_priority  INTEGER CHECK (corrected_priority IS NULL OR (corrected_priority BETWEEN 1 AND 5)),
  notes               TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (classification_id) REFERENCES classifications (id)
);

-- ── Schema Version Tracking ──────────────────────────────────
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (1, 'initial_schema');
