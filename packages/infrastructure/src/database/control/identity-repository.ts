import { randomUUID } from "node:crypto";
import type { TenantDb } from "@oneon/domain";
import { ensureIdentityAnchor, rawDb } from "../context-db-gate.js";
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
  /** True when the identity has a login of this kind (the personal context needs a Google one). */
  hasLogin(identityId: string, kind: LoginKind): boolean;
  /** One-time migration: swaps the pending "email:<email>" marker for the real Google sub. The only email lookup (spec §4.2). */
  attachGoogleSubByEmailOnce(email: string, sub: string): Identity | null;
  linkLogin(identityId: string, loginId: string, actor: string): void;
  /** Adds a new login to an identity and records the link. Returns the login's id. Throws on a duplicate (kind, subject). */
  attachLogin(identityId: string, login: { kind: LoginKind; subject: string; email?: string }, actor: string): string;
  /**
   * Merges `fromId` into `toId` (spec §4.5): its login identities and memberships move to `toId`, its tenant-file rows
   * (conversations, actions) are re-owned, its grants are revoked and it is disabled with `merged_into`. Tenant files first,
   * one at a time and idempotently; then one control transaction. Any failure throws and leaves the control database as it was.
   */
  mergeInto(fromId: string, toId: string, actor: string): { revokedGrantIds: string[] };
  /**
   * Detaches an ImpressoRx login and its memberships into a new identity. Throws UnlinkRefusedError when it may not.
   * Reports the grants it revoked so the caller can forget their cached tokens and revoke them at ImpressoRx.
   */
  unlink(identityId: string, loginIdentityId: string, actor: string): { identityId: string; revokedGrantIds: string[] };
  /** The pharmacies an identity has memberships at, with each registration's status. */
  registrationsOf(identityId: string): Array<{ id: string; status: string }>;
  /** The email on the identity's (first) Google login, or null. */
  googleEmailOf(identityId: string): string | null;
  listMemberships(identityId: string): Membership[];
}

export type UnlinkRefusal = "login_not_found" | "not_detachable" | "last_login";

/** A pharmacy on the identity is suspended or switched off, so its file cannot be updated now: nothing was changed. */
export class LinkUnavailableError extends Error {
  constructor() {
    super("link_unavailable");
    this.name = "LinkUnavailableError";
  }
}

export class UnlinkRefusedError extends Error {
  constructor(readonly reason: UnlinkRefusal) {
    super(reason);
    this.name = "UnlinkRefusedError";
  }
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
  /** `openTenant` is the gate's: a merge needs it to re-own the rows in each pharmacy file. */
  constructor(
    private readonly db: ControlDb,
    private readonly openTenant?: (registrationId: string) => TenantDb,
  ) {}

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

  hasLogin(identityId: string, kind: LoginKind): boolean {
    return this.db.prepare("SELECT 1 FROM login_identities WHERE identity_id = ? AND kind = ? LIMIT 1").get(identityId, kind) !== undefined;
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

  attachLogin(identityId: string, login: { kind: LoginKind; subject: string; email?: string }, actor: string): string {
    // "email:" is the pending-marker namespace, never a real subject (see findByLogin).
    if (login.subject.startsWith(MARKER_PREFIX)) throw new Error("not a provider subject");
    const loginId = randomUUID();
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare("INSERT INTO login_identities (id, identity_id, kind, subject, email, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(loginId, identityId, login.kind, login.subject, login.email ?? null, now);
      this.recordLinkEvent({ identityId, loginId, event: "link", actor, now });
    })();
    return loginId;
  }

  mergeInto(fromId: string, toId: string, actor: string): { revokedGrantIds: string[] } {
    if (fromId === toId) throw new Error("cannot merge an identity into itself");
    if (this.findById(fromId)?.status !== "active" || this.findById(toId)?.status !== "active") {
      throw new Error("both identities must exist and be active");
    }

    // A pharmacy that is suspended or switched off cannot have its file updated now and must not be skipped (its rows
    // would be orphaned): refuse before anything changes. A removed one has no file to serve; its memberships just move.
    const registrations = this.registrationsOf(fromId);
    if (registrations.some((r) => r.status !== "active" && r.status !== "removed")) throw new LinkUnavailableError();

    // 1. The pharmacy files, one at a time, each in its own transaction. The updates are idempotent, so a merge that
    //    failed part-way and is tried again simply finds the earlier files already done.
    const registrationIds = registrations.map((r) => r.id);
    for (const { id: registrationId } of registrations.filter((r) => r.status === "active")) {
      if (!this.openTenant) throw new Error("merging needs the tenant gate");
      const tenant = this.openTenant(registrationId);
      const raw = rawDb(tenant);
      raw.transaction(() => {
        ensureIdentityAnchor(tenant, toId);
        raw.prepare("UPDATE conversations SET user_id = ? WHERE user_id = ?").run(toId, fromId);
        raw.prepare("UPDATE action_instances SET user_id = ? WHERE user_id = ?").run(toId, fromId);
        raw.prepare("UPDATE action_instances SET initiator_user_id = ? WHERE initiator_user_id = ?").run(toId, fromId);
      })();
    }

    // 2. One control transaction: either all of it happens or none. Append-only rows (action_events, model_call_*) keep
    //    the old identity id as history.
    return this.db.transaction(() => {
      if (this.findById(fromId)?.status !== "active" || this.findById(toId)?.status !== "active") {
        throw new Error("an identity changed during the merge");
      }
      // A membership that appeared after step 1 has a file we have not re-owned: start over rather than skip it.
      if (this.registrationsOf(fromId).some((r) => !registrationIds.includes(r.id))) {
        throw new Error("memberships changed during the merge");
      }
      const logins = this.db.prepare("SELECT id FROM login_identities WHERE identity_id = ? ORDER BY created_at, id").all(fromId) as Array<{ id: string }>;
      this.db.prepare("UPDATE login_identities SET identity_id = ? WHERE identity_id = ?").run(toId, fromId);
      this.db.prepare("UPDATE memberships SET identity_id = ? WHERE identity_id = ?").run(toId, fromId);
      this.db.prepare("UPDATE identities SET status = 'disabled', merged_into = ? WHERE id = ?").run(toId, fromId);
      const now = new Date().toISOString();
      for (const login of logins) {
        this.recordLinkEvent({ identityId: toId, loginId: login.id, event: "link", actor, now, detail: { mergedFrom: fromId } });
      }
      return { revokedGrantIds: this.revokeGrants("identity_id = ?", fromId, "identity_merged") };
    }).immediate();
  }

  unlink(identityId: string, loginIdentityId: string, actor: string): { identityId: string; revokedGrantIds: string[] } {
    return this.db.transaction((): { identityId: string; revokedGrantIds: string[] } => {
      const login = this.db
        .prepare("SELECT id, kind, subject FROM login_identities WHERE id = ? AND identity_id = ?")
        .get(loginIdentityId, identityId) as { id: string; kind: LoginKind; subject: string } | undefined;
      if (!login) throw new UnlinkRefusedError("login_not_found");
      if (login.kind !== "impressorx") throw new UnlinkRefusedError("not_detachable");
      const remaining = this.db.prepare("SELECT COUNT(*) AS n FROM login_identities WHERE identity_id = ?").get(identityId) as { n: number };
      if (remaining.n < 2) throw new UnlinkRefusedError("last_login");

      const newId = randomUUID();
      const now = new Date().toISOString();
      this.db.prepare("INSERT INTO identities (id, status, created_at) VALUES (?, 'active', ?)").run(newId, now);
      this.db.prepare("UPDATE login_identities SET identity_id = ? WHERE id = ?").run(newId, login.id);
      // An ImpressoRx subject is "<registration id>:<staff user id>"; the membership it opened is the one that goes with it.
      const separator = login.subject.indexOf(":");
      const membershipIds =
        separator < 1
          ? []
          : (
              this.db
                .prepare("SELECT id FROM memberships WHERE identity_id = ? AND tenant_registration_id = ? AND external_user_id = ? ORDER BY id")
                .all(identityId, login.subject.slice(0, separator), login.subject.slice(separator + 1)) as Array<{ id: string }>
            ).map((m) => m.id);
      const revokedGrantIds: string[] = [];
      for (const membershipId of membershipIds) {
        this.db.prepare("UPDATE memberships SET identity_id = ? WHERE id = ?").run(newId, membershipId);
        revokedGrantIds.push(...this.revokeGrants("membership_id = ?", membershipId, "identity_unlinked"));
      }
      // Earlier conversations stay with the identity they were created under (spec §16.6): no tenant file is touched.
      this.recordLinkEvent({ identityId, loginId: login.id, event: "unlink", actor, now, detail: { newIdentityId: newId, membershipIds } });
      return { identityId: newId, revokedGrantIds };
    }).immediate();
  }

  registrationsOf(identityId: string): Array<{ id: string; status: string }> {
    return this.db
      .prepare(
        `SELECT DISTINCT r.id AS id, r.status AS status FROM memberships m
           JOIN tenant_registrations r ON r.id = m.tenant_registration_id
          WHERE m.identity_id = ? ORDER BY r.id`,
      )
      .all(identityId) as Array<{ id: string; status: string }>;
  }

  googleEmailOf(identityId: string): string | null {
    const row = this.db
      .prepare("SELECT email FROM login_identities WHERE identity_id = ? AND kind = 'google' ORDER BY created_at, id LIMIT 1")
      .get(identityId) as { email: string | null } | undefined;
    return row?.email ?? null;
  }

  private recordLinkEvent(e: { identityId: string; loginId: string; event: "link" | "unlink"; actor: string; now: string; detail?: object }): void {
    this.db
      .prepare(
        "INSERT INTO identity_link_events (id, identity_id, login_identity_id, event, actor_identity_id, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(randomUUID(), e.identityId, e.loginId, e.event, e.actor, e.detail ? JSON.stringify(e.detail) : null, e.now);
  }

  /**
   * Revokes the active grants matching `where`. This is GrantStore's revoke, written out here because a merge or unlink
   * must revoke in the same control transaction as the move, and only the ImpressoRx client may import the grant store (I4).
   */
  private revokeGrants(where: "identity_id = ?" | "membership_id = ?", value: string, reason: string): string[] {
    const ids = (this.db.prepare(`SELECT id FROM delegation_grants WHERE ${where} AND status = 'active' ORDER BY id`).all(value) as Array<{ id: string }>).map((r) => r.id);
    this.db
      .prepare(
        `UPDATE delegation_grants SET status = 'revoked', revoked_reason = ?, pending_request_id = NULL, pending_since = NULL,
                pending_request_json = NULL WHERE ${where} AND status = 'active'`,
      )
      .run(reason, value);
    return ids;
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
