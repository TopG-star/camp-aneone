-- Spec §8 and §2.12: personal opt-ins and the model-call audit trail. All append-only.
CREATE TABLE ai_data_choices (
  id           TEXT PRIMARY KEY,
  identity_id  TEXT NOT NULL REFERENCES users (id),
  provider     TEXT NOT NULL,
  max_class    TEXT NOT NULL CHECK (max_class IN ('D1', 'D2')),
  decided_on   TEXT,
  note         TEXT,
  confirmed_at TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_ai_data_choices_current ON ai_data_choices (identity_id, provider, created_at);

CREATE TABLE model_call_decisions (
  id                 TEXT PRIMARY KEY,
  call_id            TEXT NOT NULL UNIQUE,
  created_at         TEXT NOT NULL,
  context_kind       TEXT NOT NULL CHECK (context_kind IN ('personal', 'tenant')),
  identity_id        TEXT NOT NULL,
  tenant_id          TEXT,
  membership_id      TEXT,
  purpose            TEXT NOT NULL,
  channel            TEXT,
  provider           TEXT NOT NULL,
  model              TEXT,
  effective_limit    TEXT,
  layers_json        TEXT NOT NULL,
  decision           TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
  deny_reason        TEXT,
  released_json      TEXT NOT NULL,
  withheld_json      TEXT NOT NULL,
  placeholder_count  INTEGER NOT NULL,
  scanner_d3         INTEGER NOT NULL,
  scanner_d4         INTEGER NOT NULL,
  alert              INTEGER NOT NULL CHECK (alert IN (0, 1)),
  policy_fingerprint TEXT NOT NULL,
  input_fingerprint  TEXT,
  key_version        INTEGER NOT NULL
);
CREATE INDEX idx_model_call_decisions_identity ON model_call_decisions (identity_id, created_at);

CREATE TABLE model_call_outcomes (
  call_id            TEXT PRIMARY KEY REFERENCES model_call_decisions (call_id),
  created_at         TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('answered', 'blocked', 'failed')),
  block_reason       TEXT,
  attempts           INTEGER NOT NULL,
  latency_ms         INTEGER NOT NULL,
  input_tokens       INTEGER,
  output_tokens      INTEGER,
  checks_json        TEXT NOT NULL,
  output_fingerprint TEXT,
  key_version        INTEGER NOT NULL
);

CREATE TRIGGER ai_data_choices_no_update BEFORE UPDATE ON ai_data_choices
BEGIN SELECT RAISE(ABORT, 'ai_data_choices is append-only'); END;
CREATE TRIGGER ai_data_choices_no_delete BEFORE DELETE ON ai_data_choices
BEGIN SELECT RAISE(ABORT, 'ai_data_choices is append-only'); END;
CREATE TRIGGER model_call_decisions_no_update BEFORE UPDATE ON model_call_decisions
BEGIN SELECT RAISE(ABORT, 'model_call_decisions is append-only'); END;
CREATE TRIGGER model_call_decisions_no_delete BEFORE DELETE ON model_call_decisions
BEGIN SELECT RAISE(ABORT, 'model_call_decisions is append-only'); END;
CREATE TRIGGER model_call_outcomes_no_update BEFORE UPDATE ON model_call_outcomes
BEGIN SELECT RAISE(ABORT, 'model_call_outcomes is append-only'); END;
CREATE TRIGGER model_call_outcomes_no_delete BEFORE DELETE ON model_call_outcomes
BEGIN SELECT RAISE(ABORT, 'model_call_outcomes is append-only'); END;
