import { randomUUID } from "node:crypto";
import type { ControlDb } from "./open-control-db.js";
import type { JWK } from "../../crypto/jws.js";
import type { SealedSecret } from "../../crypto/envelope.js";

export type TenantRegistrationStatus = "active" | "suspended_by_operator" | "disabled_by_tenant" | "removed";

export interface TenantRegistration {
  id: string;
  tenantId: string;
  /** ImpressoRx's Tenant.id, the pharmacy's permanent identity (not Oneon's `tenantId`). Null for a registration from before it was sent. */
  impressorxTenantId: string | null;
  tenantSlug: string;
  displayName: string;
  origin: string;
  fileName: string;
  status: TenantRegistrationStatus;
  enrolledBy: string;
  enrolledAt: string;
}

export interface OneonKey {
  keyId: string;
  publicKeyJwk: JWK;
  sealedPrivateKey: SealedSecret;
}

export interface DeploymentKey {
  keyId: string;
  publicKeyJwk: JWK;
  retiredAt: string | null;
}

export interface CreateTenantRegistrationInput {
  tenantSlug: string;
  displayName: string;
  origin: string;
  deploymentKeyId: string;
  deploymentPublicKeyJwk: JWK;
  oneonKeyId: string;
  oneonPublicKeyJwk: JWK;
  oneonPrivateKeySealed: SealedSecret;
  impressorxTenantId: string;
  enrolledBy: string;
}

/** The keys a re-enrolment proved: they replace every key of the registration at once. */
export interface ReenrolmentKeys {
  deploymentKeyId: string;
  deploymentPublicKeyJwk: JWK;
  oneonKeyId: string;
  oneonPublicKeyJwk: JWK;
  oneonPrivateKeySealed: SealedSecret;
}

/** A retiring key stays valid for this long (spec §5.4). */
export const KEY_OVERLAP_MS = 7 * 24 * 60 * 60 * 1000;

type RegistrationRow = {
  id: string;
  tenant_id: string;
  impressorx_tenant_id: string | null;
  tenant_slug: string;
  display_name: string;
  origin: string;
  file_name: string;
  status: TenantRegistrationStatus;
  enrolled_by: string;
  enrolled_at: string;
};

type KeyRow = {
  key_id: string;
  public_key_jwk: string;
  private_key_wrapped: string | null;
  private_key_ciphertext: string | null;
  retired_at: string | null;
};

function toRegistration(row: RegistrationRow): TenantRegistration {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    impressorxTenantId: row.impressorx_tenant_id,
    tenantSlug: row.tenant_slug,
    displayName: row.display_name,
    origin: row.origin,
    fileName: row.file_name,
    status: row.status,
    enrolledBy: row.enrolled_by,
    enrolledAt: row.enrolled_at,
  };
}

export class TenantRegistrationRepository {
  constructor(
    private readonly db: ControlDb,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * Registration, both first keys and the audit event are written together or not at all.
   * `inTransaction` runs before commit and sees the new rows; if it throws, everything rolls back.
   */
  create(input: CreateTenantRegistrationInput, inTransaction?: (registration: TenantRegistration) => void): TenantRegistration {
    const id = randomUUID();
    const now = this.clock().toISOString();
    const run = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO tenant_registrations
             (id, tenant_id, impressorx_tenant_id, tenant_slug, display_name, origin, file_name, status, enrolled_by, enrolled_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        )
        .run(id, id, input.impressorxTenantId, input.tenantSlug, input.displayName, input.origin, `${id}.db`, input.enrolledBy, now);
      this.insertKey(id, "deployment", input.deploymentKeyId, input.deploymentPublicKeyJwk, null, now);
      this.insertKey(id, "oneon", input.oneonKeyId, input.oneonPublicKeyJwk, input.oneonPrivateKeySealed, now);
      this.insertEvent(id, "enrolled", input.enrolledBy, { origin: input.origin, tenantSlug: input.tenantSlug }, now);
      inTransaction?.(this.findById(id)!);
    });
    run();
    return this.findById(id)!;
  }

  /**
   * Re-enrolment of a suspended registration (ruling): in one transaction, and only if it is still `suspended_by_operator`, every
   * unretired key of both owners is retired now (no overlap), the proved keys are added, `inTransaction` runs (grant revocation),
   * a `reenrolled` event is written and the status becomes `active`. The row, its tenant_id and file, and its memberships are kept.
   * A registration from before ImpressoRx sent its tenant id records `impressorxTenantId` now; one that holds an id must be given
   * the same one. Throws when the registration is no longer suspended or the id differs; then nothing changes.
   */
  replaceKeysOnReenrolment(
    id: string,
    keys: ReenrolmentKeys,
    impressorxTenantId: string,
    actor: string,
    inTransaction?: () => void,
  ): TenantRegistration {
    const now = this.clock().toISOString();
    const run = this.db.transaction(() => {
      const current = this.db.prepare("SELECT impressorx_tenant_id FROM tenant_registrations WHERE id = ?").get(id) as
        | { impressorx_tenant_id: string | null }
        | undefined;
      if (current?.impressorx_tenant_id != null && current.impressorx_tenant_id !== impressorxTenantId) {
        throw new Error("The deployment answered as another pharmacy than the one registered");
      }
      const recorded = current?.impressorx_tenant_id == null;
      const changed = this.db
        .prepare(
          "UPDATE tenant_registrations SET status = 'active', impressorx_tenant_id = ? WHERE id = ? AND status = 'suspended_by_operator'",
        )
        .run(impressorxTenantId, id).changes;
      if (changed !== 1) throw new Error("Only a suspended registration can be re-enrolled");
      // Every key of both owners, a key still inside a rotation overlap included, stops verifying and signing now.
      this.db
        .prepare("UPDATE tenant_keys SET retired_at = ? WHERE tenant_registration_id = ? AND (retired_at IS NULL OR retired_at > ?)")
        .run(now, id, now);
      this.insertKey(id, "deployment", keys.deploymentKeyId, keys.deploymentPublicKeyJwk, null, now);
      this.insertKey(id, "oneon", keys.oneonKeyId, keys.oneonPublicKeyJwk, keys.oneonPrivateKeySealed, now);
      inTransaction?.();
      this.insertEvent(
        id,
        "reenrolled",
        actor,
        { oneonKeyId: keys.oneonKeyId, deploymentKeyId: keys.deploymentKeyId, impressorxTenantIdRecorded: recorded },
        now,
      );
      this.insertEvent(id, "status_changed", actor, { from: "suspended_by_operator", to: "active", reason: "reenrolled" }, now);
    });
    run();
    return this.findById(id)!;
  }

  findById(id: string): TenantRegistration | null {
    const row = this.db.prepare("SELECT * FROM tenant_registrations WHERE id = ?").get(id) as RegistrationRow | undefined;
    return row ? toRegistration(row) : null;
  }

  findBySlug(slug: string): TenantRegistration | null {
    const row = this.db.prepare("SELECT * FROM tenant_registrations WHERE tenant_slug = ?").get(slug) as RegistrationRow | undefined;
    return row ? toRegistration(row) : null;
  }

  /** The active registration whose rows carry this tenant id (UNIQUE); null when absent or not active. */
  findByTenantId(tenantId: string): TenantRegistration | null {
    const row = this.db
      .prepare("SELECT * FROM tenant_registrations WHERE tenant_id = ? AND status = 'active'")
      .get(tenantId) as RegistrationRow | undefined;
    return row ? toRegistration(row) : null;
  }

  /** The registration, whatever its status, that holds this ImpressoRx Tenant.id (UNIQUE where set); null when none does. */
  findByImpressorxTenantId(impressorxTenantId: string): TenantRegistration | null {
    const row = this.db.prepare("SELECT * FROM tenant_registrations WHERE impressorx_tenant_id = ?").get(impressorxTenantId) as
      | RegistrationRow
      | undefined;
    return row ? toRegistration(row) : null;
  }

  /** `iss` is "impressorx:<slug>". */
  findByIssuer(iss: string): TenantRegistration | null {
    const prefix = "impressorx:";
    return iss.startsWith(prefix) ? this.findBySlug(iss.slice(prefix.length)) : null;
  }

  listActive(): TenantRegistration[] {
    const rows = this.db
      .prepare("SELECT * FROM tenant_registrations WHERE status = 'active' ORDER BY enrolled_at, id")
      .all() as RegistrationRow[];
    return rows.map(toRegistration);
  }

  /** Every registration whatever its status (the operator's view), oldest first. */
  listAll(): TenantRegistration[] {
    const rows = this.db.prepare("SELECT * FROM tenant_registrations ORDER BY enrolled_at, id").all() as RegistrationRow[];
    return rows.map(toRegistration);
  }

  /**
   * Moves a registration from `from` to `to` and records the event, only if it is in `from` now (checked and changed in one
   * transaction). "unknown" when there is no such registration, "conflict" when it is in another status.
   */
  transitionStatus(
    id: string,
    from: TenantRegistrationStatus,
    to: TenantRegistrationStatus,
    actor: string | null,
    reason: string,
  ): "ok" | "unknown" | "conflict" {
    const run = this.db.transaction((): "ok" | "unknown" | "conflict" => {
      const changed = this.db.prepare("UPDATE tenant_registrations SET status = ? WHERE id = ? AND status = ?").run(to, id, from).changes;
      if (changed === 0) return this.findById(id) ? "conflict" : "unknown";
      this.insertEvent(id, "status_changed", actor, { from, to, reason }, this.clock().toISOString());
      return "ok";
    });
    return run();
  }

  setStatus(id: string, status: TenantRegistrationStatus, actor: string | null, reason: string): void {
    const now = this.clock().toISOString();
    const run = this.db.transaction(() => {
      const previous = this.db.prepare("SELECT status FROM tenant_registrations WHERE id = ?").get(id) as { status: string } | undefined;
      if (!previous) throw new Error("Unknown tenant registration");
      this.db.prepare("UPDATE tenant_registrations SET status = ? WHERE id = ?").run(status, id);
      this.insertEvent(id, "status_changed", actor, { from: previous.status, to: status, reason }, now);
    });
    run();
  }

  /** Oneon's newest unretired signing key (still sealed). */
  currentOneonKey(registrationId: string): OneonKey | null {
    const row = this.db
      .prepare(
        `SELECT key_id, public_key_jwk, private_key_wrapped, private_key_ciphertext, retired_at FROM tenant_keys
         WHERE tenant_registration_id = ? AND owner = 'oneon' AND retired_at IS NULL
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(registrationId) as KeyRow | undefined;
    if (!row) return null;
    return {
      keyId: row.key_id,
      publicKeyJwk: JSON.parse(row.public_key_jwk) as JWK,
      sealedPrivateKey: { wrappedKey: row.private_key_wrapped!, ciphertext: row.private_key_ciphertext! },
    };
  }

  /** Unretired Oneon key ids, newest first. */
  unretiredOneonKeyIds(registrationId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT key_id FROM tenant_keys WHERE tenant_registration_id = ? AND owner = 'oneon' AND retired_at IS NULL
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all(registrationId) as Array<{ key_id: string }>;
    return rows.map((r) => r.key_id);
  }

  /** Unretired Oneon keys with their sealed private keys, newest first. */
  unretiredOneonKeys(registrationId: string): OneonKey[] {
    const rows = this.db
      .prepare(
        `SELECT key_id, public_key_jwk, private_key_wrapped, private_key_ciphertext, retired_at FROM tenant_keys
         WHERE tenant_registration_id = ? AND owner = 'oneon' AND retired_at IS NULL
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all(registrationId) as KeyRow[];
    return rows.map((row) => ({
      keyId: row.key_id,
      publicKeyJwk: JSON.parse(row.public_key_jwk) as JWK,
      sealedPrivateKey: { wrappedKey: row.private_key_wrapped!, ciphertext: row.private_key_ciphertext! },
    }));
  }

  /** Stores a new Oneon key before it is offered to the deployment; the other keys stay as they are. */
  addPendingOneonKey(registrationId: string, keyId: string, publicKeyJwk: JWK, sealed: SealedSecret): void {
    this.insertKey(registrationId, "oneon", keyId, publicKeyJwk, sealed, this.clock().toISOString());
  }

  /** The deployment accepted `keepKeyId`: every other unretired Oneon key keeps working for the overlap period. */
  retireOtherOneonKeys(registrationId: string, keepKeyId: string, actor: string | null = null): void {
    const now = this.clock();
    const run = this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE tenant_keys SET retired_at = ? WHERE tenant_registration_id = ? AND owner = 'oneon' AND retired_at IS NULL AND key_id <> ?",
        )
        .run(new Date(now.getTime() + KEY_OVERLAP_MS).toISOString(), registrationId, keepKeyId);
      this.insertEvent(registrationId, "oneon_key_rotated", actor, { keyId: keepKeyId }, now.toISOString());
    });
    run();
  }

  /** The deployment definitely refused a pending key. */
  deleteOneonKey(registrationId: string, keyId: string): void {
    this.db
      .prepare("DELETE FROM tenant_keys WHERE tenant_registration_id = ? AND owner = 'oneon' AND key_id = ? AND retired_at IS NULL")
      .run(registrationId, keyId);
  }

  /** Deployment public keys that may verify a message now: unretired, or retiring but not yet expired. */
  deploymentKeys(registrationId: string): DeploymentKey[] {
    const rows = this.db
      .prepare(
        `SELECT key_id, public_key_jwk, retired_at FROM tenant_keys
         WHERE tenant_registration_id = ? AND owner = 'deployment' AND (retired_at IS NULL OR retired_at > ?)
         ORDER BY created_at, rowid`,
      )
      .all(registrationId, this.clock().toISOString()) as KeyRow[];
    return rows.map((row) => ({ keyId: row.key_id, publicKeyJwk: JSON.parse(row.public_key_jwk) as JWK, retiredAt: row.retired_at }));
  }

  addDeploymentKey(registrationId: string, keyId: string, publicKeyJwk: JWK, retiredAt: string | null = null): void {
    this.insertKey(registrationId, "deployment", keyId, publicKeyJwk, null, this.clock().toISOString(), retiredAt);
  }

  /** Makes the stored deployment keys match the deployment's own list; keys it no longer lists are retired now. */
  replaceDeploymentKeys(registrationId: string, keys: Array<{ keyId: string; publicKeyJwk: JWK; retiresAt: string | null }>): void {
    const nowIso = this.clock().toISOString();
    const run = this.db.transaction(() => {
      const known = new Set(
        (
          this.db.prepare("SELECT key_id FROM tenant_keys WHERE tenant_registration_id = ? AND owner = 'deployment'").all(registrationId) as Array<{
            key_id: string;
          }>
        ).map((r) => r.key_id),
      );
      for (const key of keys) {
        if (known.has(key.keyId)) {
          this.db
            .prepare("UPDATE tenant_keys SET retired_at = ? WHERE key_id = ? AND tenant_registration_id = ? AND owner = 'deployment'")
            .run(key.retiresAt, key.keyId, registrationId);
        } else {
          this.insertKey(registrationId, "deployment", key.keyId, key.publicKeyJwk, null, nowIso, key.retiresAt);
        }
      }
      const listed = new Set(keys.map((k) => k.keyId));
      for (const keyId of known) {
        if (!listed.has(keyId)) {
          this.db
            .prepare("UPDATE tenant_keys SET retired_at = ? WHERE key_id = ? AND tenant_registration_id = ? AND retired_at IS NULL")
            .run(nowIso, keyId, registrationId);
        }
      }
      this.insertEvent(registrationId, "deployment_keys_refreshed", null, { keyIds: keys.map((k) => k.keyId) }, nowIso);
    });
    run();
  }

  private insertKey(
    registrationId: string,
    owner: "oneon" | "deployment",
    keyId: string,
    publicKeyJwk: JWK,
    sealed: SealedSecret | null,
    createdAt: string,
    retiredAt: string | null = null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO tenant_keys (id, tenant_registration_id, owner, key_id, public_key_jwk, private_key_wrapped, private_key_ciphertext, created_at, retired_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), registrationId, owner, keyId, JSON.stringify(publicKeyJwk), sealed?.wrappedKey ?? null, sealed?.ciphertext ?? null, createdAt, retiredAt);
  }

  private insertEvent(registrationId: string, event: string, actor: string | null, detail: object, createdAt: string): void {
    this.db
      .prepare(
        `INSERT INTO tenant_registration_events (id, tenant_registration_id, event, actor_identity_id, detail_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), registrationId, event, actor, JSON.stringify(detail), createdAt);
  }
}
