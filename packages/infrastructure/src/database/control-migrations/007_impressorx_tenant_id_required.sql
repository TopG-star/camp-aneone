-- Owner decision D1: every registration holds ImpressoRx's Tenant.id. Re-enrolment always compares it with the stored one, so a
-- registration without it would trust whatever id the next re-enrolment presents. SQLite cannot add NOT NULL to an existing column
-- cheaply, so the rule is enforced here, at migration time, and by the triggers below (and in code).
--
-- A control file holding a registration without the id refuses this migration, and so the server refuses to start, naming every such
-- registration. Nothing is changed: the migration's transaction rolls back. Such a control file predates the id (no production
-- registration does) and must be created again (owner decision D1, option b).
CREATE TEMP TABLE migration_007_missing_ids (registrations TEXT);
CREATE TEMP TRIGGER migration_007_refuse BEFORE INSERT ON migration_007_missing_ids WHEN NEW.registrations IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Control migration 007 refused: every tenant registration needs its impressorx_tenant_id (ImpressoRx''s Tenant.id), and these have none: ' || NEW.registrations || '. See DEPLOY.md, "Pharmacies (ImpressoRx)".');
END;
INSERT INTO migration_007_missing_ids
  SELECT group_concat(id || ' (' || tenant_slug || ')', ', ') FROM tenant_registrations WHERE impressorx_tenant_id IS NULL;
DROP TRIGGER migration_007_refuse;
DROP TABLE migration_007_missing_ids;

CREATE TRIGGER tenant_registrations_impressorx_tenant_id_insert BEFORE INSERT ON tenant_registrations
WHEN NEW.impressorx_tenant_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'impressorx_tenant_id is required');
END;

CREATE TRIGGER tenant_registrations_impressorx_tenant_id_update BEFORE UPDATE ON tenant_registrations
WHEN NEW.impressorx_tenant_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'impressorx_tenant_id is required');
END;
