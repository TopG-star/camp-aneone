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

type Entry = { db: TenantDb; conn: Database.Database; leases: number; closed: boolean };

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
    const path = this.tenantPath(reg.file_name);
    // Opening a missing SQLite path would create it; the gate never creates a file on open.
    if (!existsSync(path)) throw new TenantRefusedError("tenant_file_missing");

    let conn: Database.Database;
    try {
      conn = createDatabase(path);
    } catch {
      throw new TenantRefusedError("tenant_unavailable");
    }
    try {
      this.verifyFile(conn, reg.tenant_id);
    } catch (error) {
      conn.close();
      throw error;
    }
    return this.remember(registrationId, reg.tenant_id, conn);
  }

  /**
   * The only way to a tenant handle: opens the tenant and holds it until `release()`. A leased entry is never evicted by the LRU (the
   * cache size is a soft target and stays exceeded while every entry is leased); if the tenant is suspended while leased, new leases
   * are refused at once but the file closes at the last release.
   */
  lease(registrationId: string): TenantLease {
    const db = this.openCached(registrationId);
    const entry = this.cache.get(registrationId)!;
    entry.leases += 1;
    let released = false;
    return {
      db,
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

  private verifyFile(conn: Database.Database, tenantId: string): void {
    const has = (table: string) =>
      conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
    const version = has("schema_migrations")
      ? ((conn.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null }).v ?? 0)
      : 0;
    const meta = has("context_meta")
      ? (conn.prepare("SELECT kind, tenant_id FROM context_meta").all() as Array<{ kind: string; tenant_id: string | null }>)
      : [];
    const latest = latestMigrationVersion();

    // A file from before context_meta existed cannot name its tenant yet; it is behind, not foreign.
    if (meta.length === 0 && version < latest) throw new TenantRefusedError("tenant_schema_behind");
    const identityOk = meta.length === 1 && meta[0]!.kind === "tenant" && meta[0]!.tenant_id === tenantId;
    if (!identityOk) throw new TenantRefusedError("tenant_unavailable");
    if (version < latest) throw new TenantRefusedError("tenant_schema_behind");
    if (version > latest) throw new TenantRefusedError("tenant_unavailable");
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
