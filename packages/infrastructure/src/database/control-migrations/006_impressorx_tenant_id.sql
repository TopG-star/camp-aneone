-- ImpressoRx's Tenant.id, signed into its enrol reply: made once per pharmacy database and never reused. The slug is only a name; a
-- pharmacy deleted and set up again can come back under the same one, and re-enrolment matched on the slug would hand it the old
-- pharmacy's registration. Re-enrolment refuses a reply whose id differs from the one stored here.
-- Nullable: registrations enrolled before ImpressoRx sent it hold none until their next re-enrolment records it. Unique where set, so
-- one pharmacy (or a copy of its database) cannot hold two registrations. Not tenant_id: that column is Oneon's own id.
ALTER TABLE tenant_registrations ADD COLUMN impressorx_tenant_id TEXT;
CREATE UNIQUE INDEX tenant_registrations_impressorx_tenant_id ON tenant_registrations (impressorx_tenant_id)
  WHERE impressorx_tenant_id IS NOT NULL;
