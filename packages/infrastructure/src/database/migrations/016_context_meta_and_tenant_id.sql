-- Context files (personal and one per tenant) share this schema; context_meta says which one a file is.
CREATE TABLE context_meta (
  kind           TEXT NOT NULL CHECK (kind IN ('personal','tenant')),
  tenant_id      TEXT,
  schema_version INTEGER NOT NULL,
  created_at     TEXT NOT NULL
);

-- Nullable: existing rows belong to the personal context. ADD COLUMN does not fire the append-only triggers.
-- model_call_decisions already has tenant_id (migration 015), as action_instances does (014).
ALTER TABLE conversations ADD COLUMN tenant_id TEXT;
ALTER TABLE action_events ADD COLUMN tenant_id TEXT;
ALTER TABLE model_call_outcomes ADD COLUMN tenant_id TEXT;
