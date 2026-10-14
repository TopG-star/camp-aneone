import { randomUUID } from "node:crypto";
import { classRank } from "@oneon/application";
import type { ControlDb } from "./open-control-db.js";

/** The classes a pharmacy may set. D3 and D4 are never allowed (spec 9.4), and the table refuses them. */
export type TenantLimitClass = "D0" | "D1" | "D2";

/** What applies to a pharmacy that has never set a limit. */
export const DEFAULT_TENANT_LIMIT: TenantLimitClass = "D1";

export interface TenantAiLimitVersion {
  id: string;
  registrationId: string;
  maxClass: TenantLimitClass;
  /** The identity that made the change. */
  setBy: string;
  /** What the live ImpressoRx check that authorized the change recorded (a JSON text the caller chooses). */
  liveCheckRef: string | null;
  /** Why a raise was allowed; null for a lowering. */
  evidence: Record<string, unknown> | null;
  createdAt: string;
}

export interface NewTenantAiLimitVersion {
  registrationId: string;
  maxClass: TenantLimitClass;
  setBy: string;
  liveCheckRef: string;
  evidence: Record<string, unknown> | null;
}

/**
 * `limit_changed`: the newest row is not the class the change was based on. `prerequisites_missing`: a raise `onRaise` could not justify.
 * `live_check_required`: a change authorised from the cached snapshot that is not a strict lowering.
 */
export type TenantLimitChange =
  | { ok: true }
  | { ok: false; reason: "limit_changed" | "prerequisites_missing" | "live_check_required"; current: TenantLimitClass };

/** A lowering authorised from the cached snapshot whose re-check has now been made. */
export interface ResolvedRecheck {
  versionId: string;
  registrationId: string;
  maxClass: TenantLimitClass;
}

type Row = {
  id: string;
  tenant_registration_id: string;
  max_class: TenantLimitClass;
  set_by: string;
  live_check_ref: string | null;
  evidence_json: string | null;
  created_at: string;
};

const toVersion = (r: Row): TenantAiLimitVersion => ({
  id: r.id,
  registrationId: r.tenant_registration_id,
  maxClass: r.max_class,
  setBy: r.set_by,
  liveCheckRef: r.live_check_ref,
  evidence: r.evidence_json === null ? null : (JSON.parse(r.evidence_json) as Record<string, unknown>),
  createdAt: r.created_at,
});

/**
 * A pharmacy's AI data limit (spec 9.4): append-only rows in the control database, keyed by the registration. The newest row applies
 * (the last one inserted: rows cannot be deleted, so insertion order is the order, whatever the clock said), and a pharmacy with none is
 * at D1. Nothing is cached here: the gateway reads the newest row on every call, so a lowering applies at once.
 */
export class TenantAiLimitRepository {
  constructor(
    private readonly db: ControlDb,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  current(registrationId: string): TenantLimitClass {
    const row = this.db
      .prepare("SELECT max_class FROM tenant_ai_limit_versions WHERE tenant_registration_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(registrationId) as Pick<Row, "max_class"> | undefined;
    return row?.max_class ?? DEFAULT_TENANT_LIMIT;
  }

  /** Newest first. */
  history(registrationId: string): TenantAiLimitVersion[] {
    const rows = this.db
      .prepare("SELECT * FROM tenant_ai_limit_versions WHERE tenant_registration_id = ? ORDER BY rowid DESC")
      .all(registrationId) as Row[];
    return rows.map(toVersion);
  }

  /**
   * Writes a row, unconditionally. A caller that changes a limit for a person goes through `change`, which decides against the row it
   * writes after.
   */
  append(v: NewTenantAiLimitVersion): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO tenant_ai_limit_versions (id, tenant_registration_id, max_class, set_by, live_check_ref, evidence_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, v.registrationId, v.maxClass, v.setBy, v.liveCheckRef, v.evidence === null ? null : JSON.stringify(v.evidence), this.clock().toISOString());
    return id;
  }

  /**
   * Changes the limit, deciding against the newest row as it is when the new one is written: the read, the decision and the insert run in
   * one BEGIN IMMEDIATE transaction, so two changes at once are decided one after the other, each against the row the other left, and a
   * change judged to be a lowering cannot have been read from a row that a raise has since replaced.
   * `expectedCurrent` is the class the person was looking at. When it is given and the newest row is not that class, nothing is written
   * (`limit_changed`), so a change based on a stale view cannot overwrite what someone else has just set.
   * Keeping the class or lowering it is written as it is. Raising it asks `onRaise` (inside the transaction) for the evidence that
   * allows it; null means the prerequisites are missing, nothing is written, and the answer says what the limit still is.
   * `cachedSnapshot` (spec 9.4, owner decision 2026-10-14): the change rests on the membership's cached snapshot because ImpressoRx could
   * not be reached. Only a strict lowering is then written (anything else is `live_check_required`, and `onRaise` is never asked), and
   * with it a pending re-check for that membership, in the same transaction.
   */
  change(
    v: Omit<NewTenantAiLimitVersion, "evidence"> & { expectedCurrent?: TenantLimitClass; cachedSnapshot?: { membershipId: string } },
    onRaise: () => Record<string, unknown> | null,
  ): TenantLimitChange {
    const { expectedCurrent, cachedSnapshot, ...write } = v;
    return this.db
      .transaction((): TenantLimitChange => {
        const current = this.current(write.registrationId);
        if (expectedCurrent !== undefined && expectedCurrent !== current) return { ok: false, reason: "limit_changed", current };
        if (cachedSnapshot && classRank(write.maxClass) >= classRank(current)) return { ok: false, reason: "live_check_required", current };
        let evidence: Record<string, unknown> | null = null;
        if (classRank(write.maxClass) > classRank(current)) {
          evidence = onRaise();
          if (evidence === null) return { ok: false, reason: "prerequisites_missing", current };
        }
        const versionId = this.append({ ...write, evidence });
        if (cachedSnapshot) {
          this.db
            .prepare("INSERT INTO tenant_ai_limit_rechecks (version_id, membership_id, created_at) VALUES (?, ?, ?)")
            .run(versionId, cachedSnapshot.membershipId, this.clock().toISOString());
        }
        return { ok: true };
      })
      .immediate();
  }

  /**
   * Makes the re-check of every lowering this membership made from its cached snapshot and that is still pending: records when and whether
   * the person still had the permission (`stillPermitted`, from the snapshot ImpressoRx has just delivered), and answers those lowerings.
   * Each is resolved once. The limit itself is never changed here: a lowered class stays.
   */
  resolveRechecks(membershipId: string, stillPermitted: boolean): ResolvedRecheck[] {
    return this.db
      .transaction((): ResolvedRecheck[] => {
        const rows = this.db
          .prepare(
            `SELECT r.version_id, v.tenant_registration_id, v.max_class FROM tenant_ai_limit_rechecks r
             JOIN tenant_ai_limit_versions v ON v.id = r.version_id
             WHERE r.membership_id = ? AND r.rechecked_at IS NULL ORDER BY r.rowid`,
          )
          .all(membershipId) as Array<{ version_id: string; tenant_registration_id: string; max_class: TenantLimitClass }>;
        const resolve = this.db.prepare("UPDATE tenant_ai_limit_rechecks SET rechecked_at = ?, outcome = ? WHERE version_id = ? AND rechecked_at IS NULL");
        const at = this.clock().toISOString();
        for (const row of rows) resolve.run(at, stillPermitted ? "confirmed" : "permission_lost", row.version_id);
        return rows.map((r) => ({ versionId: r.version_id, registrationId: r.tenant_registration_id, maxClass: r.max_class }));
      })
      .immediate();
  }
}
