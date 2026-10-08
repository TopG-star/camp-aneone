import { randomUUID } from "node:crypto";
import { openSecret, sealSecret } from "../../crypto/envelope.js";
import type { ControlDb } from "./open-control-db.js";

export type GrantKind = "attended" | "action" | "schedule";

export interface InsertGrant {
  id: string;
  identityId: string;
  membershipId: string;
  tenantRegistrationId: string;
  kind: GrantKind;
  scope: string[];
  /** The grant value. Named so log redaction (key `grantValue`) covers it. */
  value: string;
  generation: number;
  sessionId?: string;
  actionId?: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
}

/** Grant metadata. Never carries the value. */
export interface GrantRecord {
  id: string;
  identityId: string;
  membershipId: string;
  tenantRegistrationId: string;
  kind: GrantKind;
  scope: string[];
  generation: number;
  status: "active" | "revoked" | "expired";
  revokedReason: string | null;
  sessionId: string | null;
  actionId: string | null;
  idleExpiresAt: string | null;
  absoluteExpiresAt: string;
}

export class GrantInactiveError extends Error {
  constructor() {
    super("Grant is not active");
    this.name = "GrantInactiveError";
  }
}

type Row = {
  id: string;
  identity_id: string;
  membership_id: string;
  tenant_registration_id: string;
  kind: GrantKind;
  scope_json: string;
  encrypted_value: string;
  wrapped_key: string;
  generation: number;
  status: GrantRecord["status"];
  revoked_reason: string | null;
  session_id: string | null;
  action_id: string | null;
  pending_request_id: string | null;
  idle_expires_at: string | null;
  absolute_expires_at: string;
};

const toRecord = (r: Row): GrantRecord => ({
  id: r.id,
  identityId: r.identity_id,
  membershipId: r.membership_id,
  tenantRegistrationId: r.tenant_registration_id,
  kind: r.kind,
  scope: JSON.parse(r.scope_json) as string[],
  generation: r.generation,
  status: r.status,
  revokedReason: r.revoked_reason,
  sessionId: r.session_id,
  actionId: r.action_id,
  idleExpiresAt: r.idle_expires_at,
  absoluteExpiresAt: r.absolute_expires_at,
});

/**
 * Delegation grants in the control database, values sealed with ONEON_GRANT_MASTER_KEY.
 * Only impressorx/client.ts may import this module (architecture test I4).
 */
export class GrantStore {
  constructor(
    private readonly db: ControlDb,
    private readonly masterKeyB64: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  insert(g: InsertGrant): void {
    this.insertRow(g);
  }

  find(id: string): GrantRecord | null {
    const row = this.db.prepare("SELECT * FROM delegation_grants WHERE id = ?").get(id) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  /**
   * Inside BEGIN IMMEDIATE: returns the current value and the request id for the next exchange. A request id stored by an
   * earlier exchange that never completed is reused, so a crash retry presents the same value and the same id.
   */
  beginExchange(id: string): { value: string; generation: number; requestId: string } {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM delegation_grants WHERE id = ?").get(id) as Row | undefined;
      if (!row || row.status !== "active") throw new GrantInactiveError();
      const requestId = row.pending_request_id ?? randomUUID();
      if (!row.pending_request_id) {
        this.db.prepare("UPDATE delegation_grants SET pending_request_id = ? WHERE id = ?").run(requestId, id);
      }
      const value = openSecret({ wrappedKey: row.wrapped_key, ciphertext: row.encrypted_value }, this.masterKeyB64);
      return { value, generation: row.generation, requestId };
    }).immediate();
  }

  /** Stores the rotated value and clears the pending request id. `issued` is inserted in the same transaction. */
  completeExchange(id: string, requestId: string, newValue: string, generation: number, issued?: InsertGrant): void {
    this.db.transaction(() => {
      const sealed = sealSecret(newValue, this.masterKeyB64);
      const result = this.db
        .prepare(
          `UPDATE delegation_grants
              SET encrypted_value = ?, wrapped_key = ?, generation = ?, pending_request_id = NULL, last_used_at = ?
            WHERE id = ? AND pending_request_id = ? AND status = 'active'`,
        )
        .run(sealed.ciphertext, sealed.wrappedKey, generation, this.clock().toISOString(), id, requestId);
      if (result.changes !== 1) throw new GrantInactiveError();
      if (issued) this.insertRow(issued);
    }).immediate();
  }

  revoke(id: string, reason: string): void {
    this.db
      .prepare("UPDATE delegation_grants SET status = 'revoked', revoked_reason = ?, pending_request_id = NULL WHERE id = ? AND status = 'active'")
      .run(reason, id);
  }

  listForIdentity(identityId: string): GrantRecord[] {
    return (this.db.prepare("SELECT * FROM delegation_grants WHERE identity_id = ? ORDER BY created_at, id").all(identityId) as Row[]).map(toRecord);
  }

  findAttendedForSession(sessionId: string): GrantRecord | null {
    const row = this.db
      .prepare("SELECT * FROM delegation_grants WHERE session_id = ? AND kind = 'attended' AND status = 'active' ORDER BY created_at DESC LIMIT 1")
      .get(sessionId) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  findActionGrant(actionId: string): string | null {
    const row = this.db
      .prepare("SELECT id FROM delegation_grants WHERE action_id = ? AND kind = 'action' AND status = 'active' ORDER BY created_at DESC LIMIT 1")
      .get(actionId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  private insertRow(g: InsertGrant): void {
    const sealed = sealSecret(g.value, this.masterKeyB64);
    this.db
      .prepare(
        `INSERT INTO delegation_grants
           (id, identity_id, membership_id, tenant_registration_id, kind, scope_json, encrypted_value, wrapped_key,
            generation, status, session_id, action_id, created_at, idle_expires_at, absolute_expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
      )
      .run(
        g.id, g.identityId, g.membershipId, g.tenantRegistrationId, g.kind, JSON.stringify(g.scope),
        sealed.ciphertext, sealed.wrappedKey, g.generation, g.sessionId ?? null, g.actionId ?? null,
        this.clock().toISOString(), g.idleExpiresAt, g.absoluteExpiresAt,
      );
  }
}
