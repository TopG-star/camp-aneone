import { randomUUID } from "node:crypto";
import type { ControlDb } from "./open-control-db.js";
import type { Membership } from "./identity-repository.js";

type MembershipRow = {
  id: string;
  identity_id: string;
  tenant_registration_id: string;
  external_user_id: string;
  role: string;
  permissions_json: string;
  location_ids_json: string;
  status: Membership["status"];
  snapshot_at: string;
};

/** What a membership takes from a deployment's snapshot (structurally the client's MembershipSnapshot). */
export interface SnapshotFields {
  role: string;
  permissions: string[];
  locationIds: string[];
  tenantStatus: string;
}

/** A membership has no snapshot until the first exchange; the epoch is older than any freshness limit. */
const NO_SNAPSHOT = new Date(0).toISOString();

function toMembership(r: MembershipRow): Membership {
  return {
    id: r.id,
    identityId: r.identity_id,
    tenantRegistrationId: r.tenant_registration_id,
    externalUserId: r.external_user_id,
    role: r.role,
    permissions: JSON.parse(r.permissions_json) as string[],
    locationIds: JSON.parse(r.location_ids_json) as string[],
    status: r.status,
    snapshotAt: r.snapshot_at,
  };
}

export class MembershipRepository {
  constructor(
    private readonly db: ControlDb,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * Finds or creates the membership of a staff user at a deployment. A new one is active with an empty snapshot; an
   * existing one keeps its status (only a snapshot or setStatus changes that) and takes the hand-off's role.
   * A membership that already belongs to another identity is never taken over.
   */
  upsertFromHandoff(input: { identityId: string; tenantRegistrationId: string; externalUserId: string; role: string }): Membership {
    const now = this.clock().toISOString();
    return this.db.transaction((): Membership => {
      this.db
        .prepare(
          `INSERT INTO memberships (id, identity_id, tenant_registration_id, external_user_id, role, permissions_json,
             location_ids_json, status, snapshot_at, created_at)
           VALUES (?, ?, ?, ?, ?, '[]', '[]', 'active', ?, ?)
           ON CONFLICT (tenant_registration_id, external_user_id) DO UPDATE SET role = excluded.role
           WHERE identity_id = excluded.identity_id`,
        )
        .run(randomUUID(), input.identityId, input.tenantRegistrationId, input.externalUserId, input.role, NO_SNAPSHOT, now);
      const row = this.db
        .prepare("SELECT * FROM memberships WHERE tenant_registration_id = ? AND external_user_id = ?")
        .get(input.tenantRegistrationId, input.externalUserId) as MembershipRow;
      if (row.identity_id !== input.identityId) throw new Error("membership belongs to another identity");
      return toMembership(row);
    })();
  }

  /**
   * Stores the deployment's view of the user. The tenant status decides active/suspended (ImpressoRx spells it
   * "Active"; the comparison ignores case). A revoked membership stays revoked: only setStatus lifts that.
   */
  applySnapshot(id: string, snapshot: SnapshotFields): void {
    const status = snapshot.tenantStatus.toLowerCase() === "active" ? "active" : "suspended";
    this.db
      .prepare(
        `UPDATE memberships SET role = ?, permissions_json = ?, location_ids_json = ?, snapshot_at = ?,
                status = CASE WHEN status = 'revoked' THEN status ELSE ? END
          WHERE id = ?`,
      )
      .run(snapshot.role, JSON.stringify(snapshot.permissions), JSON.stringify(snapshot.locationIds), this.clock().toISOString(), status, id);
  }

  setStatus(id: string, status: Membership["status"]): void {
    this.db.prepare("UPDATE memberships SET status = ? WHERE id = ?").run(status, id);
  }

  findById(id: string): Membership | null {
    const row = this.db.prepare("SELECT * FROM memberships WHERE id = ?").get(id) as MembershipRow | undefined;
    return row ? toMembership(row) : null;
  }

  listActiveForIdentity(identityId: string): Membership[] {
    const rows = this.db
      .prepare("SELECT * FROM memberships WHERE identity_id = ? AND status = 'active' ORDER BY created_at, id")
      .all(identityId) as MembershipRow[];
    return rows.map(toMembership);
  }
}
