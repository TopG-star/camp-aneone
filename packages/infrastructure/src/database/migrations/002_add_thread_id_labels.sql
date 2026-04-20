-- Camp-Aneone v2 Migration: Add thread_id and labels to inbound_items
-- Date: 2026-04-14

ALTER TABLE inbound_items ADD COLUMN thread_id TEXT;
ALTER TABLE inbound_items ADD COLUMN labels TEXT NOT NULL DEFAULT '[]';

CREATE INDEX IF NOT EXISTS idx_inbound_items_thread_id ON inbound_items (thread_id) WHERE thread_id IS NOT NULL;

INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (2, 'add_thread_id_labels');
