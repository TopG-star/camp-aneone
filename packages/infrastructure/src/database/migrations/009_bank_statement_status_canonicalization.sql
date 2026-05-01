-- Migration 009: Bank statement status canonicalization (FIN-001b)
-- Replaces legacy status values with canonical lifecycle values.

UPDATE bank_statements
SET status = 'discovered'
WHERE status IN ('queued_for_parse', 'skipped_duplicate');

ALTER TABLE bank_statements RENAME TO bank_statements_legacy_009;

CREATE TABLE bank_statements (
  id                      TEXT PRIMARY KEY,
  user_id                 TEXT NOT NULL REFERENCES users (id),
  source                  TEXT NOT NULL CHECK (source IN ('gmail', 'outlook', 'teams', 'github')),
  external_id             TEXT NOT NULL,
  message_id              TEXT NOT NULL,
  thread_id               TEXT,
  sender                  TEXT NOT NULL,
  sender_domain           TEXT NOT NULL,
  subject                 TEXT NOT NULL DEFAULT '',
  received_at             TEXT NOT NULL,
  status                  TEXT NOT NULL
    CHECK (status IN ('discovered', 'metadata_parsed', 'error_metadata', 'transactions_parsed', 'error_transactions')),
  detection_rule_version  TEXT NOT NULL,
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (user_id, source, external_id)
);

INSERT INTO bank_statements (
  id,
  user_id,
  source,
  external_id,
  message_id,
  thread_id,
  sender,
  sender_domain,
  subject,
  received_at,
  status,
  detection_rule_version,
  created_at,
  updated_at
)
SELECT
  id,
  user_id,
  source,
  external_id,
  message_id,
  thread_id,
  sender,
  sender_domain,
  subject,
  received_at,
  status,
  detection_rule_version,
  created_at,
  updated_at
FROM bank_statements_legacy_009;

DROP TABLE bank_statements_legacy_009;

CREATE INDEX IF NOT EXISTS idx_bank_statements_user_id ON bank_statements (user_id);
CREATE INDEX IF NOT EXISTS idx_bank_statements_status ON bank_statements (status);
CREATE INDEX IF NOT EXISTS idx_bank_statements_received_at ON bank_statements (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_bank_statements_sender_domain ON bank_statements (sender_domain);
