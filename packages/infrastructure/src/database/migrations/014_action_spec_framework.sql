-- Migration 014: Action Spec framework (spec §8). Supersedes ADR-006's action_log.

ALTER TABLE action_log RENAME TO action_log_legacy;

CREATE TRIGGER IF NOT EXISTS action_log_legacy_no_update
BEFORE UPDATE ON action_log_legacy
BEGIN SELECT RAISE(ABORT, 'action_log_legacy is read-only'); END;

CREATE TRIGGER IF NOT EXISTS action_log_legacy_no_delete
BEFORE DELETE ON action_log_legacy
BEGIN SELECT RAISE(ABORT, 'action_log_legacy is read-only'); END;

CREATE TABLE IF NOT EXISTS action_instances (
  id                   TEXT PRIMARY KEY,
  scope                TEXT NOT NULL CHECK (scope IN ('personal', 'tenant')),
  owner_id             TEXT NOT NULL,
  user_id              TEXT NOT NULL REFERENCES users (id),
  tenant_id            TEXT,
  location_ids_json    TEXT NOT NULL DEFAULT '[]',
  action_type          TEXT NOT NULL,
  definition_version   TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN (
                         'proposed', 'validating', 'awaiting_approval', 'approved', 'executing',
                         'verifying', 'completed', 'partially_completed', 'rejected', 'expired',
                         'cancelled', 'failed', 'rolling_back', 'rolled_back', 'rollback_failed')),
  initiator            TEXT NOT NULL,
  initiator_user_id    TEXT,
  input_json           TEXT NOT NULL,
  resolved_json        TEXT,
  evidence_json        TEXT NOT NULL DEFAULT '[]',
  decision_json        TEXT,
  result_json          TEXT,
  error_json           TEXT,
  undo_json            TEXT,
  idempotency_key      TEXT NOT NULL,
  retry_of             TEXT REFERENCES action_instances (id),
  attempt_number       INTEGER NOT NULL DEFAULT 1,
  executor_request_id  TEXT,
  execution_started_at TEXT,
  last_heartbeat_at    TEXT,
  undo_started_at      TEXT,
  resource_ref         TEXT,
  last_event_seq       INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  CHECK (
    (scope = 'personal' AND tenant_id IS NULL AND owner_id = user_id)
    OR (scope = 'tenant' AND tenant_id IS NOT NULL AND owner_id = tenant_id)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_action_instances_key
  ON action_instances (scope, owner_id, action_type, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_action_instances_owner_status
  ON action_instances (owner_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_action_instances_resource
  ON action_instances (resource_ref);

CREATE TABLE IF NOT EXISTS action_events (
  id          TEXT PRIMARY KEY,
  action_id   TEXT NOT NULL REFERENCES action_instances (id),
  seq         INTEGER NOT NULL,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  actor_json  TEXT NOT NULL,
  data_json   TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  UNIQUE (action_id, seq)
);

CREATE TRIGGER IF NOT EXISTS action_events_no_update
BEFORE UPDATE ON action_events
BEGIN SELECT RAISE(ABORT, 'action_events is append-only'); END;

CREATE TRIGGER IF NOT EXISTS action_events_no_delete
BEFORE DELETE ON action_events
BEGIN SELECT RAISE(ABORT, 'action_events is append-only'); END;

CREATE TABLE IF NOT EXISTS action_definition_configs (
  scope       TEXT NOT NULL CHECK (scope IN ('personal', 'tenant')),
  owner_id    TEXT NOT NULL,
  action_type TEXT NOT NULL,
  config_json TEXT NOT NULL,
  updated_by  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (scope, owner_id, action_type)
);

CREATE TABLE IF NOT EXISTS action_definition_config_history (
  id          TEXT PRIMARY KEY,
  scope       TEXT NOT NULL,
  owner_id    TEXT NOT NULL,
  action_type TEXT NOT NULL,
  old_json    TEXT,
  new_json    TEXT NOT NULL,
  changed_by  TEXT NOT NULL,
  changed_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_action_config_history_lookup
  ON action_definition_config_history (scope, owner_id, action_type, changed_at);

CREATE TRIGGER IF NOT EXISTS action_config_history_no_update
BEFORE UPDATE ON action_definition_config_history
BEGIN SELECT RAISE(ABORT, 'action_definition_config_history is append-only'); END;

CREATE TRIGGER IF NOT EXISTS action_config_history_no_delete
BEFORE DELETE ON action_definition_config_history
BEGIN SELECT RAISE(ABORT, 'action_definition_config_history is append-only'); END;

CREATE TABLE IF NOT EXISTS action_legacy_imports (
  legacy_id   TEXT PRIMARY KEY REFERENCES action_log_legacy (id),
  action_id   TEXT NOT NULL REFERENCES action_instances (id),
  imported_at TEXT NOT NULL
);
