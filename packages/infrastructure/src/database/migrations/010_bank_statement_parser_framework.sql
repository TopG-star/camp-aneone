CREATE TABLE IF NOT EXISTS bank_statement_metadata (
  id                    TEXT PRIMARY KEY,
  statement_id          TEXT NOT NULL UNIQUE REFERENCES bank_statements (id) ON DELETE CASCADE,
  user_id               TEXT NOT NULL REFERENCES users (id),
  account_last4         TEXT NOT NULL,
  statement_date        TEXT NOT NULL,
  period_start          TEXT NOT NULL,
  period_end            TEXT NOT NULL,
  currency              TEXT NOT NULL,
  opening_balance_minor INTEGER NOT NULL,
  closing_balance_minor INTEGER NOT NULL,
  parser_id             TEXT NOT NULL,
  parser_version        INTEGER NOT NULL,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_bank_statement_metadata_user_id
  ON bank_statement_metadata (user_id);

CREATE TABLE IF NOT EXISTS bank_statement_transactions (
  id           TEXT PRIMARY KEY,
  statement_id TEXT NOT NULL REFERENCES bank_statements (id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users (id),
  posted_at    TEXT NOT NULL,
  description  TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  balance_minor INTEGER,
  dedupe_key   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (statement_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_bank_statement_transactions_statement_id
  ON bank_statement_transactions (statement_id);

CREATE INDEX IF NOT EXISTS idx_bank_statement_transactions_user_id_posted_at
  ON bank_statement_transactions (user_id, posted_at);

CREATE TABLE IF NOT EXISTS bank_statement_parse_runs (
  id            TEXT PRIMARY KEY,
  statement_id  TEXT NOT NULL REFERENCES bank_statements (id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users (id),
  stage         TEXT NOT NULL CHECK (stage IN ('metadata', 'transactions')),
  outcome       TEXT NOT NULL CHECK (outcome IN ('success', 'error')),
  parser_id     TEXT,
  parser_version INTEGER,
  error_code    TEXT,
  error_message TEXT,
  duration_ms   INTEGER NOT NULL CHECK (duration_ms >= 0),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_bank_statement_parse_runs_statement_stage_outcome
  ON bank_statement_parse_runs (statement_id, stage, outcome);

CREATE INDEX IF NOT EXISTS idx_bank_statement_parse_runs_user_id_created_at
  ON bank_statement_parse_runs (user_id, created_at);
