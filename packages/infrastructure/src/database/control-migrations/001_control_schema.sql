-- Step B-core spec §4.1, §5.2, §6.1, §7.3, §8.8, §9.4: the control database.
CREATE TABLE identities (
  id          TEXT PRIMARY KEY,
  status      TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  merged_into TEXT REFERENCES identities (id),
  created_at  TEXT NOT NULL
);

CREATE TABLE login_identities (
  id          TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES identities (id),
  kind        TEXT NOT NULL CHECK (kind IN ('google', 'impressorx')),
  subject     TEXT NOT NULL,
  email       TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE (kind, subject)
);
CREATE INDEX idx_login_identities_identity ON login_identities (identity_id);

CREATE TABLE tenant_registrations (
  id                     TEXT PRIMARY KEY,
  tenant_id              TEXT NOT NULL UNIQUE,
  tenant_slug            TEXT NOT NULL UNIQUE,
  display_name           TEXT NOT NULL,
  origin                 TEXT NOT NULL,
  file_name              TEXT NOT NULL,
  status                 TEXT NOT NULL CHECK (status IN ('active', 'suspended_by_operator', 'disabled_by_tenant', 'removed')),
  enrolled_by            TEXT NOT NULL REFERENCES identities (id),
  enrolled_at            TEXT NOT NULL
);

CREATE TABLE tenant_keys (
  id                      TEXT PRIMARY KEY,
  tenant_registration_id  TEXT NOT NULL REFERENCES tenant_registrations (id),
  owner                   TEXT NOT NULL CHECK (owner IN ('oneon', 'deployment')),
  key_id                  TEXT NOT NULL UNIQUE,
  public_key_jwk          TEXT NOT NULL,
  private_key_wrapped     TEXT,
  private_key_ciphertext  TEXT,
  created_at              TEXT NOT NULL,
  retired_at              TEXT,
  CHECK (
    (owner = 'deployment' AND private_key_wrapped IS NULL AND private_key_ciphertext IS NULL) OR
    (owner = 'oneon' AND private_key_wrapped IS NOT NULL AND private_key_ciphertext IS NOT NULL)
  )
);
CREATE INDEX idx_tenant_keys_registration ON tenant_keys (tenant_registration_id, owner);

CREATE TABLE tenant_registration_events (
  id                     TEXT PRIMARY KEY,
  tenant_registration_id TEXT NOT NULL REFERENCES tenant_registrations (id),
  event                  TEXT NOT NULL,
  actor_identity_id      TEXT REFERENCES identities (id),
  detail_json            TEXT,
  created_at             TEXT NOT NULL
);
CREATE INDEX idx_tenant_registration_events_registration ON tenant_registration_events (tenant_registration_id, created_at);

CREATE TABLE memberships (
  id                     TEXT PRIMARY KEY,
  identity_id            TEXT NOT NULL REFERENCES identities (id),
  tenant_registration_id TEXT NOT NULL REFERENCES tenant_registrations (id),
  external_user_id       TEXT NOT NULL,
  role                   TEXT NOT NULL,
  permissions_json       TEXT NOT NULL,
  location_ids_json      TEXT NOT NULL,
  status                 TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'revoked')),
  snapshot_at            TEXT NOT NULL,
  created_at             TEXT NOT NULL,
  UNIQUE (tenant_registration_id, external_user_id)
);
CREATE INDEX idx_memberships_identity ON memberships (identity_id);

CREATE TABLE platform_operators (
  id          TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES identities (id),
  action      TEXT NOT NULL CHECK (action IN ('grant', 'remove')),
  actor_id    TEXT REFERENCES identities (id),
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_platform_operators_identity ON platform_operators (identity_id, created_at);

CREATE TABLE channel_identities (
  id             TEXT PRIMARY KEY,
  channel        TEXT NOT NULL,
  scoped_subject TEXT NOT NULL,
  scope_key      TEXT NOT NULL,
  identity_id    TEXT REFERENCES identities (id),
  status         TEXT NOT NULL CHECK (status IN ('candidate', 'verified'))
);

CREATE TABLE identity_link_events (
  id                TEXT PRIMARY KEY,
  identity_id       TEXT NOT NULL REFERENCES identities (id),
  login_identity_id TEXT REFERENCES login_identities (id),
  event             TEXT NOT NULL CHECK (event IN ('link', 'unlink')),
  actor_identity_id TEXT REFERENCES identities (id),
  detail_json       TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_identity_link_events_identity ON identity_link_events (identity_id, created_at);

CREATE TABLE delegation_grants (
  id                     TEXT PRIMARY KEY,
  identity_id            TEXT NOT NULL REFERENCES identities (id),
  membership_id          TEXT NOT NULL REFERENCES memberships (id),
  tenant_registration_id TEXT NOT NULL REFERENCES tenant_registrations (id),
  kind                   TEXT NOT NULL CHECK (kind IN ('attended', 'action', 'schedule')),
  scope_json             TEXT NOT NULL,
  encrypted_value        TEXT NOT NULL,
  wrapped_key            TEXT NOT NULL,
  generation             INTEGER NOT NULL,
  status                 TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'expired')),
  revoked_reason         TEXT,
  session_id             TEXT,
  action_id              TEXT,
  pending_request_id     TEXT,
  created_at             TEXT NOT NULL,
  last_used_at           TEXT,
  idle_expires_at        TEXT,
  absolute_expires_at    TEXT NOT NULL
);
CREATE INDEX idx_delegation_grants_membership ON delegation_grants (membership_id, kind, status);

CREATE TABLE tenant_ai_limit_versions (
  id                     TEXT PRIMARY KEY,
  tenant_registration_id TEXT NOT NULL REFERENCES tenant_registrations (id),
  max_class              TEXT NOT NULL CHECK (max_class IN ('D0', 'D1', 'D2')),
  set_by                 TEXT NOT NULL REFERENCES identities (id),
  live_check_ref         TEXT,
  evidence_json          TEXT,
  created_at             TEXT NOT NULL
);
CREATE INDEX idx_tenant_ai_limit_versions_current ON tenant_ai_limit_versions (tenant_registration_id, created_at);

CREATE TABLE tenant_rollups (
  tenant_id    TEXT NOT NULL,
  day          TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  PRIMARY KEY (tenant_id, day)
);

CREATE TABLE used_handoff_jti (
  jti        TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  used_at    TEXT NOT NULL
);

CREATE TRIGGER platform_operators_no_update BEFORE UPDATE ON platform_operators
BEGIN SELECT RAISE(ABORT, 'platform_operators is append-only'); END;
CREATE TRIGGER platform_operators_no_delete BEFORE DELETE ON platform_operators
BEGIN SELECT RAISE(ABORT, 'platform_operators is append-only'); END;
CREATE TRIGGER identity_link_events_no_update BEFORE UPDATE ON identity_link_events
BEGIN SELECT RAISE(ABORT, 'identity_link_events is append-only'); END;
CREATE TRIGGER identity_link_events_no_delete BEFORE DELETE ON identity_link_events
BEGIN SELECT RAISE(ABORT, 'identity_link_events is append-only'); END;
CREATE TRIGGER tenant_registration_events_no_update BEFORE UPDATE ON tenant_registration_events
BEGIN SELECT RAISE(ABORT, 'tenant_registration_events is append-only'); END;
CREATE TRIGGER tenant_registration_events_no_delete BEFORE DELETE ON tenant_registration_events
BEGIN SELECT RAISE(ABORT, 'tenant_registration_events is append-only'); END;
CREATE TRIGGER tenant_ai_limit_versions_no_update BEFORE UPDATE ON tenant_ai_limit_versions
BEGIN SELECT RAISE(ABORT, 'tenant_ai_limit_versions is append-only'); END;
CREATE TRIGGER tenant_ai_limit_versions_no_delete BEFORE DELETE ON tenant_ai_limit_versions
BEGIN SELECT RAISE(ABORT, 'tenant_ai_limit_versions is append-only'); END;
