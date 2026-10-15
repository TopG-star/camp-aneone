// A handle names the context it belongs to. `raw` is the underlying driver object; domain stays driver-free,
// so infrastructure narrows it (rawDb) where repositories need it.
export type PersonalDb = { readonly kind: "personal"; readonly raw: unknown; readonly __brand: "PersonalDb" };
export type TenantDb = { readonly kind: "tenant"; readonly tenantId: string; readonly raw: unknown; readonly __brand: "TenantDb" };
export type ContextDb = PersonalDb | TenantDb;

/** Thrown when a row (or a record) belongs to another context than the handle. Carries no row content. */
export class TenantMismatchError extends Error {
  readonly code = "tenant_mismatch";
  constructor(
    /** The tenant id of the handle that was used (null in personal). */
    readonly expectedTenantId: string | null,
    /** The table or repository that found the row. */
    readonly source: string,
  ) {
    super("tenant_mismatch");
    this.name = "TenantMismatchError";
  }
}

export function assertRowTenant(db: ContextDb, rowTenantId: string | null, source = "unknown"): void {
  const expected = db.kind === "tenant" ? db.tenantId : null;
  if (rowTenantId !== expected) {
    throw new TenantMismatchError(expected, source);
  }
}

/** The context a request runs in. `tenantId` is the tenant the handle's rows carry (TenantDb.tenantId). */
export type ActiveContext =
  | { kind: "personal"; identityId: string }
  | { kind: "tenant"; identityId: string; membershipId: string; tenantId: string; registrationId: string };
