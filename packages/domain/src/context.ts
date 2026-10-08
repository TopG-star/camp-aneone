// A handle names the context it belongs to. `raw` is the underlying driver object; domain stays driver-free,
// so infrastructure narrows it (rawDb) where repositories need it.
export type PersonalDb = { readonly kind: "personal"; readonly raw: unknown; readonly __brand: "PersonalDb" };
export type TenantDb = { readonly kind: "tenant"; readonly tenantId: string; readonly raw: unknown; readonly __brand: "TenantDb" };
export type ContextDb = PersonalDb | TenantDb;

export function assertRowTenant(db: ContextDb, rowTenantId: string | null): void {
  const expected = db.kind === "tenant" ? db.tenantId : null;
  if (rowTenantId !== expected) {
    throw new Error("tenant_mismatch");
  }
}
