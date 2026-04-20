-- Migration 003: Add classify_attempts counter to inbound_items
-- Tracks how many times classification has been attempted for each item.
-- Items exceeding max attempts are skipped to prevent infinite retry loops.

ALTER TABLE inbound_items ADD COLUMN classify_attempts INTEGER NOT NULL DEFAULT 0;

-- Record migration
INSERT INTO schema_migrations (version, name) VALUES (3, 'add_classify_attempts');
