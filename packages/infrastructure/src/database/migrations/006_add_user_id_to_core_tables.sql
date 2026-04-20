-- Migration 006: Add user_id to core tables
-- Enables per-user data scoping for multi-user pilot.

-- ── inbound_items ────────────────────────────────────────────
ALTER TABLE inbound_items ADD COLUMN user_id TEXT REFERENCES users (id);
CREATE INDEX IF NOT EXISTS idx_inbound_items_user_id ON inbound_items (user_id);

-- ── classifications ──────────────────────────────────────────
ALTER TABLE classifications ADD COLUMN user_id TEXT REFERENCES users (id);
CREATE INDEX IF NOT EXISTS idx_classifications_user_id ON classifications (user_id);

-- ── deadlines ────────────────────────────────────────────────
ALTER TABLE deadlines ADD COLUMN user_id TEXT REFERENCES users (id);
CREATE INDEX IF NOT EXISTS idx_deadlines_user_id ON deadlines (user_id);

-- ── action_log ───────────────────────────────────────────────
ALTER TABLE action_log ADD COLUMN user_id TEXT REFERENCES users (id);
CREATE INDEX IF NOT EXISTS idx_action_log_user_id ON action_log (user_id);

-- ── notifications ────────────────────────────────────────────
ALTER TABLE notifications ADD COLUMN user_id TEXT REFERENCES users (id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications (user_id);

-- ── conversations ────────────────────────────────────────────
ALTER TABLE conversations ADD COLUMN user_id TEXT REFERENCES users (id);
CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations (user_id);
