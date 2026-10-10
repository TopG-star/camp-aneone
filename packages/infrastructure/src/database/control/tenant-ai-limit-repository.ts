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

/** `limit_changed`: the newest row is not the class the change was based on. `prerequisites_missing`: a raise `onRaise` could not justify. */
export type TenantLimitChange = { ok: true } | { ok: false; reason: "limit_changed" | "prerequisites_missing"; current: TenantLimitClass };

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
  append(v: NewTenantAiLimitVersion): void {
    this.db
      .prepare(
        `INSERT INTO tenant_ai_limit_versions (id, tenant_registration_id, max_class, set_by, live_check_ref, evidence_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), v.registrationId, v.maxClass, v.setBy, v.liveCheckRef, v.evidence === null ? null : JSON.stringify(v.evidence), this.clock().toISOString());
  }

  /**
   * Changes the limit, deciding against the newest row as it is when the new one is written: the read, the decision and the insert run in
   * one BEGIN IMMEDIATE transaction, so two changes at once are decided one after the other, each against the row the other left, and a
   * change judged to be a lowering cannot have been read from a row that a raise has since replaced.
   * `expectedCurrent` is the class the person was looking at. When it is given and the newest row is not that class, nothing is written
   * (`limit_changed`), so a change based on a stale view cannot overwrite what someone else has just set.
   * Keeping the class or lowering it is written as it is. Raising it asks `onRaise` (inside the transaction) for the evidence that
   * allows it; null means the prerequisites are missing, nothing is written, and the answer says what the limit still is.
   */
  change(v: Omit<NewTenantAiLimitVersion, "evidence"> & { expectedCurrent?: TenantLimitClass }, onRaise: () => Record<string, unknown> | null): TenantLimitChange {
    const { expectedCurrent, ...write } = v;
    return this.db
      .transaction((): TenantLimitChange => {
        const current = this.current(write.registrationId);
        if (expectedCurrent !== undefined && expectedCurrent !== current) return { ok: false, reason: "limit_changed", current };
        let evidence: Record<string, unknown> | null = null;
        if (classRank(write.maxClass) > classRank(current)) {
          evidence = onRaise();
          if (evidence === null) return { ok: false, reason: "prerequisites_missing", current };
        }
        this.append({ ...write, evidence });
        return { ok: true };
      })
      .immediate();
  }
}
