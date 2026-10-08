import { randomUUID } from "node:crypto";
import type { ControlDb } from "./open-control-db.js";

export type LoginKind = "google" | "impressorx";
export type Identity = { id: string; status: "active" | "disabled" };
export type Membership = {
  id: string;
  identityId: string;
  tenantRegistrationId: string;
  externalUserId: string;
  role: string;
  permissions: string[];
  locationIds: string[];
  status: "active" | "suspended" | "revoked";
  snapshotAt: string;
};

export interface IdentityRepository {
  /** Looks an identity up by provider subject. Email is never a lookup key. */
  findByLogin(kind: LoginKind, subject: string): Identity | null;
  createWithLogin(input: { kind: LoginKind; subject: string; email?: string; id?: string }): Identity;
  findById(id: string): Identity | null;
  /** One-time migration: swaps the pending "email:<email>" marker for the real Google sub. The only email lookup (spec §4.2). */
  attachGoogleSubByEmailOnce(email: string, sub: string): Identity | null;
  linkLogin(identityId: string, loginId: string, actor: string): void;
  listMemberships(identityId: string): Membership[];
}

const MARKER_PREFIX = "email:";

type IdentityRow = { id: string; status: "active" | "disabled" };
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

export class SqliteIdentityRepository implements IdentityRepository {
  constructor(private readonly db: ControlDb) {}

  findByLogin(kind: LoginKind, subject: string): Identity | null {
    // "email:" is the backfill marker namespace (pending, unverified): never a real provider subject.
    if (subject.startsWith(MARKER_PREFIX)) return null;
    const row = this.db
      .prepare(
        `SELECT i.id, i.status FROM login_identities l
         JOIN identities i ON i.id = l.identity_id
         WHERE l.kind = ? AND l.subject = ?`,
      )
      .get(kind, subject) as IdentityRow | undefined;
    return row ? { id: row.id, status: row.status } : null;
  }

  findById(id: string): Identity | null {
    const row = this.db.prepare("SELECT id, status FROM identities WHERE id = ?").get(id) as IdentityRow | undefined;
    return row ? { id: row.id, status: row.status } : null;
  }

  createWithLogin(input: { kind: LoginKind; subject: string; email?: string; id?: string }): Identity {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO identities (id, status, created_at) VALUES (?, 'active', ?)").run(id, now);
      this.db
        .prepare("INSERT INTO login_identities (id, identity_id, kind, subject, email, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(randomUUID(), id, input.kind, input.subject, input.email ?? null, now);
    })();
    return { id, status: "active" };
  }

  attachGoogleSubByEmailOnce(email: string, sub: string): Identity | null {
    if (sub.startsWith(MARKER_PREFIX)) return null;
    return this.db.transaction((): Identity | null => {
      const row = this.db
        .prepare(
          `SELECT l.id AS login_id, i.id, i.status FROM login_identities l
           JOIN identities i ON i.id = l.identity_id
           WHERE l.kind = 'google' AND l.subject = ?`,
        )
        .get(`email:${email}`) as (IdentityRow & { login_id: string }) | undefined;
      if (!row) return null;
      this.db.prepare("UPDATE login_identities SET subject = ? WHERE id = ?").run(sub, row.login_id);
      return { id: row.id, status: row.status };
    })();
  }

  linkLogin(identityId: string, loginId: string, actor: string): void {
    this.db.transaction(() => {
      const moved = this.db.prepare("UPDATE login_identities SET identity_id = ? WHERE id = ?").run(identityId, loginId);
      if (moved.changes === 0) throw new Error(`login identity not found: ${loginId}`);
      this.db
        .prepare(
          "INSERT INTO identity_link_events (id, identity_id, login_identity_id, event, actor_identity_id, created_at) VALUES (?, ?, ?, 'link', ?, ?)",
        )
        .run(randomUUID(), identityId, loginId, actor, new Date().toISOString());
    })();
  }

  listMemberships(identityId: string): Membership[] {
    const rows = this.db
      .prepare(
        `SELECT id, identity_id, tenant_registration_id, external_user_id, role, permissions_json, location_ids_json, status, snapshot_at
         FROM memberships WHERE identity_id = ? ORDER BY created_at, id`,
      )
      .all(identityId) as MembershipRow[];
    return rows.map((r) => ({
      id: r.id,
      identityId: r.identity_id,
      tenantRegistrationId: r.tenant_registration_id,
      externalUserId: r.external_user_id,
      role: r.role,
      permissions: JSON.parse(r.permissions_json) as string[],
      locationIds: JSON.parse(r.location_ids_json) as string[],
      status: r.status,
      snapshotAt: r.snapshot_at,
    }));
  }
}
