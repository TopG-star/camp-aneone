import type Database from "better-sqlite3";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ContextDb, PersonalDb, TenantDb } from "@oneon/domain";
import { createDatabase, latestMigrationVersion, runMigrations } from "./connection.js";
import type { ControlDb } from "./control/open-control-db.js";

const FILE_NAME = /^[0-9a-f-]{36}\.db$/;

/** The one place a registry file name becomes a path: the name must match the pattern, so it cannot leave tenantDir. */
export function tenantFilePath(tenantDir: string, fileName: string): string {
  if (!FILE_NAME.test(fileName)) throw new TenantRefusedError("tenant_unavailable");
  return join(tenantDir, fileName);
}

export class TenantRefusedError extends Error {
  /** `tenant_file_missing` is an active registration whose file is not on disk: the operator's alert, never shown to the client. */
  constructor(public readonly code: "tenant_unavailable" | "tenant_schema_behind" | "tenant_file_missing") {
    super(code);
    this.name = "TenantRefusedError";
  }
}

export function rawDb(db: ContextDb): Database.Database {
  return db.raw as Database.Database;
}

export function ensureIdentityAnchor(db: ContextDb, identityId: string): void {
  rawDb(db)
    .prepare("INSERT OR IGNORE INTO users (id, email) VALUES (?, ?)")
    .run(identityId, `${identityId}@anchor.invalid`);
}

type Registration = { tenant_id: string; file_name: string; status: string };

type Entry = { db: TenantDb; conn: Database.Database; leases: number; closed: boolean; maintenanceOf?: string };

/** A handle held for the length of a job: never closed or evicted by the cache while held. */
export interface TenantLease {
  db: TenantDb;
  /** Idempotent. */
  release(): void;
}

/** The only module that turns a context into a database handle. */
export class ContextDbGate {
  private personal: PersonalDb | null = null;
  private readonly cache = new Map<string, Entry>();
  /** Entries out of the cache (a suspension) whose connection stays open until the last lease ends. */
  private readonly detached = new Set<Entry>();
  /** The uncached handle maintenance leases share, per registration (a suspended pharmacy, or a file that is behind); also in `detached`. */
  private readonly maintenance = new Map<string, Entry>();
  private readonly cacheSize: number;

  constructor(private readonly deps: { control: ControlDb; personalPath: string; tenantDir: string; cacheSize?: number }) {
    this.cacheSize = deps.cacheSize ?? 32;
  }

  openPersonal(): PersonalDb {
    if (this.personal) return this.personal;
    const conn = createDatabase(this.deps.personalPath);
    runMigrations(conn);
    const hasRow = conn.prepare("SELECT 1 FROM context_meta LIMIT 1").get() !== undefined;
    if (!hasRow) {
      conn
        .prepare("INSERT INTO context_meta (kind, tenant_id, schema_version, created_at) VALUES ('personal', NULL, ?, ?)")
        .run(latestMigrationVersion(), new Date().toISOString());
    }
    this.personal = { kind: "personal", raw: conn, __brand: "PersonalDb" };
    return this.personal;
  }

  private openCached(registrationId: string): TenantDb {
    // The registry is consulted on every call, so a suspension takes effect even for a cached handle.
    const reg = this.registration(registrationId);
    const cached = this.cache.get(registrationId);
    if (cached) {
      if (reg.status !== "active" || reg.tenant_id !== cached.db.tenantId) {
        this.evict(registrationId);
        throw new TenantRefusedError("tenant_unavailable");
      }
      this.cache.delete(registrationId);
      this.cache.set(registrationId, cached);
      return cached.db;
    }

    if (reg.status !== "active") throw new TenantRefusedError("tenant_unavailable");
    const conn = this.openFile(reg);
    try {
      this.verifyFile(conn, reg.tenant_id, false);
    } catch (error) {
      conn.close();
      throw error;
    }
    return this.remember(registrationId, reg.tenant_id, conn);
  }

  private openFile(reg: Registration): Database.Database {
    const path = this.tenantPath(reg.file_name);
    // Opening a missing SQLite path would create it; the gate never creates a file on open.
    if (!existsSync(path)) throw new TenantRefusedError("tenant_file_missing");
    try {
      return createDatabase(path);
    } catch {
      throw new TenantRefusedError("tenant_unavailable");
    }
  }

  /**
   * The only way to a tenant handle: opens the tenant and holds it until `release()`. A leased entry is never evicted by the LRU (the
   * cache size is a soft target and stays exceeded while every entry is leased); if the tenant is suspended while leased, new leases
   * are refused at once but the file closes at the last release.
   */
  lease(registrationId: string): TenantLease {
    this.openCached(registrationId);
    return this.hold(this.cache.get(registrationId)!);
  }

  /**
   * Owner decision D5: a lease for the nightly and hourly backups and for Resume's migration only, never for a request path (the
   * architecture test holds every caller to backup.ts and migrate-all.ts). It also opens a `suspended_by_operator` pharmacy, so a
   * suspended pharmacy stays backed up and can be migrated before it is served again; `removed` and `disabled_by_tenant` are refused
   * like any other status. The same leasing rules as `lease()`: held until `release()`, never closed meanwhile, and a detach closes it
   * at the last release, as does `close()` at once.
   *
   * An active pharmacy's handle comes from, and stays in, the cache, as with `lease()`. A suspended pharmacy's handle, and a handle on a
   * file that is behind, is kept out of the cache: maintenance leases of that pharmacy share it, it closes at their last release (so a
   * suspended file is not left open), and `lease()` never sees it.
   *
   * `allowSchemaBehind` (the migration only): a file whose schema is behind opens too, still checked to be this tenant's. Any other
   * maintenance lease on that handle is refused `tenant_schema_behind` until the file has been migrated on it.
   */
  leaseForMaintenance(registrationId: string, opts: { allowSchemaBehind?: boolean } = {}): TenantLease {
    const reg = this.registration(registrationId);
    if (reg.status !== "active" && reg.status !== "suspended_by_operator") throw new TenantRefusedError("tenant_unavailable");
    const allowBehind = opts.allowSchemaBehind === true;
    const cached = this.cache.get(registrationId);
    if (cached && reg.tenant_id !== cached.db.tenantId) {
      this.evict(registrationId);
      throw new TenantRefusedError("tenant_unavailable");
    }
    if (cached && reg.status === "active") {
      this.cache.delete(registrationId);
      this.cache.set(registrationId, cached);
      return this.hold(cached);
    }
    if (cached) {
      // A suspended pharmacy's handle still in the cache leaves it now, so that it closes at the last release.
      this.cache.delete(registrationId);
      this.keepForMaintenance(registrationId, cached);
    }

    const shared = this.maintenance.get(registrationId);
    if (shared) {
      if (shared.db.tenantId !== reg.tenant_id) throw new TenantRefusedError("tenant_unavailable");
      this.verifyFile(shared.conn, reg.tenant_id, allowBehind);
      return this.hold(shared);
    }
    const conn = this.openFile(reg);
    let schema: "current" | "behind";
    try {
      schema = this.verifyFile(conn, reg.tenant_id, allowBehind);
    } catch (error) {
      conn.close();
      throw error;
    }
    if (schema === "current" && reg.status === "active") {
      this.remember(registrationId, reg.tenant_id, conn);
      return this.hold(this.cache.get(registrationId)!);
    }
    const entry: Entry = { db: { kind: "tenant", tenantId: reg.tenant_id, raw: conn, __brand: "TenantDb" }, conn, leases: 0, closed: false };
    this.keepForMaintenance(registrationId, entry);
    return this.hold(entry);
  }

  /** An uncached entry: `detached` closes it at the last release (and close() at once); `maintenance` lets the next maintenance lease share it. */
  private keepForMaintenance(registrationId: string, entry: Entry): void {
    entry.maintenanceOf = registrationId;
    this.detached.add(entry);
    this.maintenance.set(registrationId, entry);
  }

  private hold(entry: Entry): TenantLease {
    entry.leases += 1;
    let released = false;
    return {
      db: entry.db,
      release: () => {
        if (released) return;
        released = true;
        entry.leases -= 1;
        if (entry.leases > 0) return;
        if (this.detached.has(entry)) this.closeEntry(entry);
        else this.trim();
      },
    };
  }

  /** Runs `fn` with the tenant leased for exactly as long as it runs: a sync function until it returns, an async one until it settles. */
  withTenant<T>(registrationId: string, fn: (db: TenantDb) => T): T {
    return runLeased(this.lease(registrationId), fn);
  }

  /**
   * Called when a registration stops being servable (an operator suspends it): its cached handle leaves the cache now. It closes at once
   * when nothing uses it, otherwise at the last release. The gate would also notice at the next lease attempt, but a file nobody tries
   * again must not stay open.
   */
  detach(registrationId: string): void {
    this.evict(registrationId);
  }

  /** Creates the tenant's file and closes it again: use `lease` or `withTenant` to open it. */
  createTenantFile(registrationId: string, tenantId: string): void {
    const reg = this.registration(registrationId);
    if (reg.tenant_id !== tenantId) throw new TenantRefusedError("tenant_unavailable");
    const path = this.tenantPath(reg.file_name);
    if (existsSync(path)) throw new Error("tenant_file_exists");
    mkdirSync(this.deps.tenantDir, { recursive: true });

    const conn = createDatabase(path);
    try {
      runMigrations(conn);
      conn
        .prepare("INSERT INTO context_meta (kind, tenant_id, schema_version, created_at) VALUES ('tenant', ?, ?, ?)")
        .run(tenantId, latestMigrationVersion(), new Date().toISOString());
    } catch (error) {
      conn.close();
      // Nothing half-written may stay behind: a leftover file would block the retry with tenant_file_exists.
      for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
      throw error;
    }
    conn.close();
  }

  close(): void {
    for (const id of [...this.cache.keys()]) this.evict(id);
    for (const entry of [...this.detached]) this.closeEntry(entry);
    if (this.personal) {
      rawDb(this.personal).close();
      this.personal = null;
    }
  }

  private registration(registrationId: string): Registration {
    const reg = this.deps.control
      .prepare("SELECT tenant_id, file_name, status FROM tenant_registrations WHERE id = ?")
      .get(registrationId) as Registration | undefined;
    if (!reg) throw new TenantRefusedError("tenant_unavailable");
    return reg;
  }

  private tenantPath(fileName: string): string {
    return tenantFilePath(this.deps.tenantDir, fileName);
  }

  /** Refuses a file that is not this tenant's, or newer than this release; a file that is behind is refused unless `allowBehind`. */
  private verifyFile(conn: Database.Database, tenantId: string, allowBehind: boolean): "current" | "behind" {
    const has = (table: string) =>
      conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
    const version = has("schema_migrations")
      ? ((conn.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null }).v ?? 0)
      : 0;
    const meta = has("context_meta")
      ? (conn.prepare("SELECT kind, tenant_id FROM context_meta").all() as Array<{ kind: string; tenant_id: string | null }>)
      : [];
    const latest = latestMigrationVersion();

    // A file from before context_meta existed cannot name its tenant yet; it is behind, not foreign. (Its migration checks it.)
    if (meta.length === 0 && version < latest) {
      if (allowBehind) return "behind";
      throw new TenantRefusedError("tenant_schema_behind");
    }
    const identityOk = meta.length === 1 && meta[0]!.kind === "tenant" && meta[0]!.tenant_id === tenantId;
    if (!identityOk) throw new TenantRefusedError("tenant_unavailable");
    if (version > latest) throw new TenantRefusedError("tenant_unavailable");
    if (version < latest) {
      if (allowBehind) return "behind";
      throw new TenantRefusedError("tenant_schema_behind");
    }
    return "current";
  }

  private remember(registrationId: string, tenantId: string, conn: Database.Database): TenantDb {
    const db: TenantDb = { kind: "tenant", tenantId, raw: conn, __brand: "TenantDb" };
    this.cache.set(registrationId, { db, conn, leases: 0, closed: false });
    this.trim(registrationId);
    return db;
  }

  /** Brings the cache back to its size, least recently used first. A leased entry is skipped: nothing closes while in use. */
  private trim(keep?: string): void {
    for (const [id, entry] of this.cache) {
      if (this.cache.size <= this.cacheSize) break;
      if (entry.leases > 0 || id === keep) continue;
      this.cache.delete(id);
      this.closeEntry(entry);
    }
  }

  /** Takes the entry out of the cache. It closes now, or at the last release when it is leased. */
  private evict(registrationId: string): void {
    const entry = this.cache.get(registrationId);
    if (!entry) return;
    this.cache.delete(registrationId);
    if (entry.leases > 0) this.detached.add(entry);
    else this.closeEntry(entry);
  }

  private closeEntry(entry: Entry): void {
    this.detached.delete(entry);
    if (entry.maintenanceOf !== undefined && this.maintenance.get(entry.maintenanceOf) === entry) this.maintenance.delete(entry.maintenanceOf);
    if (entry.closed) return;
    entry.closed = true;
    entry.conn.close();
  }
}

/** Runs `fn` on a held lease and releases it when `fn` is done: a sync function when it returns or throws, an async one when it settles. */
export function runLeased<T>(lease: TenantLease, fn: (db: TenantDb) => T): T {
  let result: T;
  try {
    result = fn(lease.db);
  } catch (error) {
    lease.release();
    throw error;
  }
  if (isPromiseLike(result)) {
    return Promise.resolve(result).finally(() => lease.release()) as T;
  }
  lease.release();
  return result;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}
