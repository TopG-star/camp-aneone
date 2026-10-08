import type Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ContextDb, PersonalDb, TenantDb } from "@oneon/domain";
import { createDatabase, latestMigrationVersion, runMigrations } from "./connection.js";
import type { ControlDb } from "./control/open-control-db.js";

const FILE_NAME = /^[0-9a-f-]{36}\.db$/;

export class TenantRefusedError extends Error {
  constructor(public readonly code: "tenant_unavailable" | "tenant_schema_behind") {
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

/** The only module that turns a context into a database handle. */
export class ContextDbGate {
  private personal: PersonalDb | null = null;
  private readonly cache = new Map<string, { db: TenantDb; conn: Database.Database }>();
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

  openTenant(registrationId: string): TenantDb {
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
    // Opening a missing SQLite path would create it; openTenant never creates.
    if (!existsSync(path)) throw new TenantRefusedError("tenant_unavailable");

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

  createTenantFile(registrationId: string, tenantId: string): TenantDb {
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
      throw error;
    }
    return this.remember(registrationId, tenantId, conn);
  }

  close(): void {
    for (const id of [...this.cache.keys()]) this.evict(id);
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
    if (!FILE_NAME.test(fileName)) throw new TenantRefusedError("tenant_unavailable");
    return join(this.deps.tenantDir, fileName);
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
    this.cache.set(registrationId, { db, conn });
    while (this.cache.size > this.cacheSize) {
      this.evict(this.cache.keys().next().value as string);
    }
    return db;
  }

  private evict(registrationId: string): void {
    const entry = this.cache.get(registrationId);
    if (!entry) return;
    this.cache.delete(registrationId);
    entry.conn.close();
  }
}
