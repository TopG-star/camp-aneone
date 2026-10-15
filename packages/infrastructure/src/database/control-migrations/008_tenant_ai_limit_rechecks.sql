-- Step B-core spec 9.4 (owner decision 2026-10-14): while ImpressoRx is unreachable, a pharmacy's AI limit may be lowered on the strength
-- of the admin's cached membership snapshot. Each such lowering is checked again the next time ImpressoRx delivers a snapshot for that
-- membership. One row per lowering, written in the same transaction as its tenant_ai_limit_versions row; rechecked_at and outcome are set
-- once, when the check is made. The membership id is a plain id: the row must never stand in the way of a membership changing.
CREATE TABLE tenant_ai_limit_rechecks (
  version_id    TEXT PRIMARY KEY REFERENCES tenant_ai_limit_versions (id),
  membership_id TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  rechecked_at  TEXT,
  outcome       TEXT CHECK (outcome IN ('confirmed', 'permission_lost')),
  CHECK ((rechecked_at IS NULL) = (outcome IS NULL))
);
CREATE INDEX idx_tenant_ai_limit_rechecks_pending ON tenant_ai_limit_rechecks (membership_id) WHERE rechecked_at IS NULL;
