import { beforeAll, describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const posix = (p: string) => p.split(sep).join("/");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (name === "node_modules" || name === "dist") return [];
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

const IMPORT = /(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g;

type Source = { path: string; text: string };

/**
 * The tables the tenant-file migrations leave, each with the text that defines its columns. Statements are applied in file order:
 * CREATE TABLE, ALTER TABLE ... RENAME TO, ALTER TABLE ... ADD COLUMN and DROP TABLE. Comments are ignored.
 */
function migratedTables(migrations: Array<{ name: string; sql: string }>): Map<string, string> {
  const tables = new Map<string, string>();
  const statement =
    /CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?\s*(?:USING\s+\w+\s*)?\(([\s\S]*?)\)\s*;|ALTER\s+TABLE\s+["`]?(\w+)["`]?\s+RENAME\s+TO\s+["`]?(\w+)["`]?|ALTER\s+TABLE\s+["`]?(\w+)["`]?\s+ADD\s+(?:COLUMN\s+)?["`]?(\w+)["`]?|DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["`]?(\w+)["`]?/gi;
  for (const { sql } of [...migrations].sort((a, b) => a.name.localeCompare(b.name))) {
    for (const m of sql.replace(/--[^\n]*/g, "").matchAll(statement)) {
      const [, created, body, from, to, altered, column, dropped] = m;
      if (created) tables.set(created, tables.get(created) ?? body!);
      else if (from && to) {
        tables.set(to, tables.get(from) ?? "");
        tables.delete(from);
      } else if (altered && column) tables.set(altered, `${tables.get(altered) ?? ""},\n${column}`);
      else if (dropped) tables.delete(dropped);
    }
  }
  return tables;
}

type TenantTable = { column: "tenant_id" | "owner_id"; repository: string; why: string };

/** What is wrong with the migrated tables against the two placement lists (spec 8.4). Empty means nothing. */
function placementOffenders(tables: Map<string, string>, tenantData: Record<string, TenantTable>, exempt: Record<string, string>): string[] {
  const offenders: string[] = [];
  for (const name of tables.keys()) {
    const listed = [name in tenantData, name in exempt].filter(Boolean).length;
    if (listed === 0) offenders.push(`${name}: on neither list (spec 8.4: add it to the tenant-data tables or the exempt tables)`);
    if (listed === 2) offenders.push(`${name}: on both lists`);
  }
  for (const name of [...Object.keys(tenantData), ...Object.keys(exempt)]) {
    if (!tables.has(name)) offenders.push(`${name}: listed, but no migration leaves this table`);
  }
  for (const [name, t] of Object.entries(tenantData)) {
    const body = tables.get(name);
    if (body !== undefined && !new RegExp(String.raw`(^|[\s,(])${t.column}\b`).test(body)) offenders.push(`${name}: a tenant-data table without ${t.column}`);
  }
  return offenders;
}

/**
 * Spec 8.4 (amendment A1). The tables a tenant file writes: each carries its tenant on every row, and the repository that writes it
 * checks that tenant against the handle (`assertRowTenant` for a `tenant_id` table; for the action config tables, which carry the
 * tenant id as `owner_id` under `scope = 'tenant'`, a guard at the top of every method that throws TenantMismatchError, B-14-1).
 */
const TENANT_DATA_TABLES: Record<string, TenantTable> = {
  conversations: { column: "tenant_id", repository: "sqlite-conversation.repository.ts", why: "a tenant conversation's messages" },
  action_instances: { column: "tenant_id", repository: "sqlite-action-instance.repository.ts", why: "actions proposed in a pharmacy" },
  action_events: { column: "tenant_id", repository: "sqlite-action-instance.repository.ts", why: "each pharmacy action's history" },
  model_call_decisions: { column: "tenant_id", repository: "sqlite-model-audit.repository.ts", why: "the model-call audit of a tenant call (spec 9.5)" },
  model_call_outcomes: { column: "tenant_id", repository: "sqlite-model-audit.repository.ts", why: "the outcome of a tenant model call" },
  action_definition_configs: { column: "owner_id", repository: "sqlite-action-config.repository.ts", why: "a pharmacy's action settings, owned by its tenant id" },
  action_definition_config_history: { column: "owner_id", repository: "sqlite-action-config.repository.ts", why: "the history of a pharmacy's action settings" },
};

/** Spec 8.4 (amendment A1). Tables a tenant file never fills with tenant data, each with the reason. */
const TENANT_EXEMPT_TABLES: Record<string, string> = {
  // Bookkeeping: present in every file, not tenant content.
  schema_migrations: "bookkeeping: the migrations applied to this file",
  context_meta: "bookkeeping: the file's own kind and tenant, checked by the gate when it opens the file",
  users: "bookkeeping: identity anchor rows (an identity id and a placeholder address) that let the file's foreign keys hold",
  // Personal-only: their repositories are built on the personal file alone (the container), so a tenant file leaves them empty.
  inbound_items: "personal-only: Gmail intake",
  classifications: "personal-only: Gmail classification",
  classification_feedback: "personal-only: Gmail classification feedback",
  deadlines: "personal-only: deadlines from a person's mail",
  notifications: "personal-only: a person's notifications",
  preferences: "personal-only: a person's preferences",
  push_subscriptions: "personal-only: a person's browser push subscriptions",
  oauth_tokens: "personal-only: a person's Google tokens",
  user_profiles: "personal-only: a person's profile",
  bank_statements: "personal-only: finance",
  bank_statement_metadata: "personal-only: finance",
  bank_statement_transactions: "personal-only: finance",
  bank_statement_parse_runs: "personal-only: finance",
  personal_memory_notes: "personal-only: personal memory",
  personal_memory_pins: "personal-only: personal memory",
  action_log_legacy: "personal-only: legacy actions (B-14-2; the legacy repository refuses a tenant handle)",
  action_legacy_imports: "personal-only: legacy action imports (B-14-2)",
  ai_data_choices: "personal-only: a person's AI data choices; a pharmacy's limit is tenant_ai_limit_versions in control.db",
};

// Walking and reading every source file is slow under a loaded full suite, so it happens once, with generous timeouts.
const TIMEOUT_MS = 60_000;

describe("architecture", { timeout: TIMEOUT_MS }, () => {
  let sources: Source[] = [];
  beforeAll(() => {
    sources = ["domain", "application", "infrastructure", "agent-server"]
      .flatMap((pkg) => sourceFiles(join(ROOT, pkg, "src")))
      .map((f) => ({ path: posix(relative(ROOT, f)), text: readFileSync(f, "utf8") }));
  }, TIMEOUT_MS);

  it("domain imports only relative paths inside domain", () => {
    const domainSrc = join(ROOT, "domain", "src");
    const offenders: string[] = [];
    // ADR-002's zero-dependency rule governs domain runtime code; tests may import vitest.
    for (const file of sourceFiles(domainSrc).filter((f) => !/\.test\.ts$/.test(f))) {
      for (const [, spec] of readFileSync(file, "utf8").matchAll(IMPORT)) {
        const inside = spec.startsWith(".") && resolve(dirname(file), spec).startsWith(domainSrc);
        if (!inside) offenders.push(`${posix(relative(ROOT, file))} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("only executors, the calendar adapter and the wiring import CalendarWriter", () => {
    const allowed = [
      /^domain\/src\/ports\/calendar\.port\.ts$/,
      /^domain\/src\/actions\/capabilities\.ts$/,
      /^application\/src\/actions\/definitions\//,
      /^application\/src\/actions\/__tests__\//,
      /^infrastructure\/src\/calendar\//,
      /^agent-server\/src\/actions-wiring\.ts$/,
      /\.test\.ts$/,
    ];
    const offenders = sources
      .filter((f) => /import[^;]*\bCalendarWriter\b[^;]*from/.test(f.text))
      .map((f) => f.path)
      .filter((p) => !allowed.some((re) => re.test(p)));
    expect(offenders).toEqual([]);
  });

  it("executors never import the instance repository", () => {
    const offenders = sourceFiles(join(ROOT, "application", "src", "actions", "definitions"))
      .filter((f) => /\bActionInstanceRepository\b/.test(readFileSync(f, "utf8")))
      .map((f) => posix(relative(ROOT, f)));
    expect(offenders).toEqual([]);
  });

  it("chat tools never construct or receive a calendar writer", () => {
    const routes = readFileSync(join(ROOT, "agent-server", "src", "routes", "index.ts"), "utf8");
    expect(routes).not.toMatch(/createCreateCalendarEventTool|createUpdateCalendarEventTool/);
    expect(readFileSync(join(ROOT, "application", "src", "actions", "chat-action-tools.ts"), "utf8")).not.toMatch(/CalendarWriter|writers/);
  });

  const isTest = (p: string) => /\.test\.ts$/.test(p) || /\/__tests__\//.test(p);

  it("only the gateway mints approved model calls (spec §5.5)", () => {
    const offenders = sources
      .filter((f) => /ApprovedModelCall\.mint\(/.test(f.text))
      .map((f) => f.path)
      .filter((p) => !isTest(p) && p !== "application/src/ai-boundary/gateway.ts" && p !== "application/src/ai-boundary/approved-call.ts");
    expect(offenders).toEqual([]);
  });

  it("nothing casts to ApprovedModelCall or Instruction outside their own modules", () => {
    const offenders = sources
      .filter((f) => /\bas\s+(ApprovedModelCall|Instruction)\b/.test(f.text))
      .map((f) => f.path)
      .filter((p) => !isTest(p) && !/^application\/src\/ai-boundary\/(instruction|approved-call)\.ts$/.test(p));
    expect(offenders).toEqual([]);
  });

  it("provider clients are constructed only by the model wiring", () => {
    const offenders = sources
      .filter((f) => /new\s+(DeepSeekProvider|AnthropicProvider)\(/.test(f.text))
      .map((f) => f.path)
      .filter((p) => !isTest(p) && p !== "agent-server/src/model-wiring.ts");
    expect(offenders).toEqual([]);
  });

  it("only provider clients import a model SDK or the model HTTP client", () => {
    const offenders = sources
      .filter((f) => /(from\s+|import\(\s*|require\(\s*)["'](@anthropic-ai\/sdk|[./]*deepseek-http-client(\.js)?)["']/.test(f.text))
      .map((f) => f.path)
      .filter((p) => !isTest(p) && !/^infrastructure\/src\/llm\/providers\//.test(p) && p !== "infrastructure/src/llm/index.ts");
    expect(offenders).toEqual([]);
  });

  // backup.ts opens only decrypted temp copies of backups (the restore test), never a live context file.
  const mayConstructDatabase = (p: string) =>
    p === "infrastructure/src/database/connection.ts" ||
    p === "infrastructure/src/database/context-db-gate.ts" ||
    p === "infrastructure/src/database/backup.ts";

  it("only the gate, connection.ts and backup.ts (decrypted temp copies) construct a SQLite Database", () => {
    // Every package, not just the four in `sources`.
    const offenders = readdirSync(ROOT)
      .filter((pkg) => existsSync(join(ROOT, pkg, "src")))
      .flatMap((pkg) => sourceFiles(join(ROOT, pkg, "src")))
      .map((f) => posix(relative(ROOT, f)))
      .filter((p) => !isTest(p) && !mayConstructDatabase(p))
      .filter((p) => /\bnew\s+Database\(/.test(readFileSync(join(ROOT, p), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("only connection.ts, the gate, the control opener and migrate-all call createDatabase", () => {
    const allowed = new Set([
      "infrastructure/src/database/connection.ts",
      "infrastructure/src/database/context-db-gate.ts",
      "infrastructure/src/database/control/open-control-db.ts",
      "infrastructure/src/database/migrate-all.ts",
    ]);
    const offenders = readdirSync(ROOT)
      .filter((pkg) => existsSync(join(ROOT, pkg, "src")))
      .flatMap((pkg) => sourceFiles(join(ROOT, pkg, "src")))
      .map((f) => posix(relative(ROOT, f)))
      .filter((p) => !isTest(p) && !allowed.has(p))
      .filter((p) => /\bcreateDatabase\(/.test(readFileSync(join(ROOT, p), "utf8")));
    expect(offenders).toEqual([]);
  });

  // A value import (anything but `import type`) of the SQLite driver, however it is bound or loaded.
  const valueImportsSqlite = (text: string) =>
    /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']better-sqlite3["']/.test(
      text.replace(/\bimport\s+type\b[^;]*?\bfrom\s*["']better-sqlite3["']/g, ""),
    );

  it("the driver matcher catches renamed, call-without-new, require and dynamic imports, and allows import type", () => {
    expect(valueImportsSqlite('import Sqlite from "better-sqlite3"; new Sqlite(p)')).toBe(true);
    expect(valueImportsSqlite('import * as S from "better-sqlite3"; S.default(p)')).toBe(true);
    expect(valueImportsSqlite('import Database from "better-sqlite3"; Database(p)')).toBe(true);
    expect(valueImportsSqlite('const D = require("better-sqlite3"); new D(p)')).toBe(true);
    expect(valueImportsSqlite('new (require("better-sqlite3"))(p)')).toBe(true);
    expect(valueImportsSqlite('const { default: D } = await import("better-sqlite3")')).toBe(true);
    expect(valueImportsSqlite('import "better-sqlite3";')).toBe(true);
    expect(valueImportsSqlite('import type Database from "better-sqlite3";')).toBe(false);
    expect(valueImportsSqlite('import type Database from "better-sqlite3";\nconst x = 1;')).toBe(false);
  });

  it("only the gate, connection.ts and backup.ts value-import the SQLite driver", () => {
    // backup.ts must import it to construct the Database it may (see mayConstructDatabase).
    const offenders = readdirSync(ROOT)
      .filter((pkg) => existsSync(join(ROOT, pkg, "src")))
      .flatMap((pkg) => sourceFiles(join(ROOT, pkg, "src")))
      .map((f) => posix(relative(ROOT, f)))
      .filter((p) => !isTest(p) && !mayConstructDatabase(p))
      .filter((p) => valueImportsSqlite(readFileSync(join(ROOT, p), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the gate hands out a tenant handle only through a lease, and holds no timers", () => {
    const gate = sources.find((f) => f.path === "infrastructure/src/database/context-db-gate.ts")!.text;
    // A public method returning a TenantDb would be an unleased path; `private` ones (the cache) are fine.
    expect(gate.match(/^ {2}(?!private\b)(?:async\s+)?\w+(?:<[^>]*>)?\([^)]*\)\s*:\s*TenantDb\b/gm) ?? []).toEqual([]);
    expect(gate).not.toMatch(/setTimeout|setInterval/);
    const offenders = sources.filter((f) => !isTest(f.path) && /\bopenTenant\b/.test(f.text)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("only backups and the pharmacy-file migration name the gate's maintenance lease; request code never does (owner decision D5)", () => {
    // The maintenance lease opens a suspended pharmacy's file. Routes and middleware reach a migration only through an injected
    // function (Resume, re-enrolment), never the lease itself.
    const allowed = new Set([
      "infrastructure/src/database/context-db-gate.ts",
      "infrastructure/src/database/backup.ts",
      "infrastructure/src/database/migrate-all.ts",
    ]);
    const callers = sources.filter((f) => !isTest(f.path) && /\bleaseForMaintenance\b/.test(f.text)).map((f) => f.path);
    expect(callers.filter((p) => !allowed.has(p))).toEqual([]);
    expect(callers).toContain("infrastructure/src/database/backup.ts");
  });

  it("repositories accept handles, not paths", () => {
    const offenders = sources
      .filter((f) => /^infrastructure\/src\/database\/repositories\//.test(f.path) && !isTest(f.path))
      .filter((f) =>
        [...f.text.matchAll(/constructor\s*\(([^)]*)\)/g)].some(([, params]) => /\b(path|dbPath)\s*\??\s*:\s*string\b/.test(params!)),
      )
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("only the ImpressoRx client imports the grant store (I4)", () => {
    const offenders = sources
      .filter((f) => /(from\s+|import\(\s*|require\(\s*)["'][^"']*grant-store(\.js)?["']/.test(f.text))
      .map((f) => f.path)
      .filter((p) => !isTest(p) && p !== "infrastructure/src/impressorx/client.ts");
    expect(offenders).toEqual([]);
  });

  it("model clients and providers are named in imports or exports only by the llm module and the model wiring", () => {
    const names = /\b(DeepSeekHttpClient|DeepSeekProvider|AnthropicProvider)\b/;
    const statements = /\b(?:import|export)\b[^;'"]*?\bfrom\s*["'][^"']+["']/g;
    const offenders = sources
      .filter((f) => [...f.text.matchAll(statements)].some(([m]) => names.test(m)) || /(import|require)\(\s*["']@anthropic-ai\/sdk["']/.test(f.text))
      .map((f) => f.path)
      .filter((p) => !isTest(p) && !/^infrastructure\/src\/llm\//.test(p) && p !== "agent-server/src/model-wiring.ts");
    expect(offenders).toEqual([]);
  });

  it("no route reads a tenant or registration id from the request (I1)", () => {
    // The context comes from the session only. Any req.body / req.query / req.params access that names a tenant is a hole.
    const ID = String.raw`\b(?:tenantId|tenant_id|registrationId)\b`;
    const REQ = String.raw`\breq\s*\.\s*(?:body|query|params)\b`;
    const reads = new RegExp(
      [`${REQ}[^;\\n]*${ID}`, `${ID}[^;\\n]*${REQ}`, String.raw`\{[^}]*${ID}[^}]*\}\s*=\s*${REQ}`].join("|"),
    );
    // Exempt: the operator-only platform registration routes (rotate-key, suspend, resume). They sit behind the platform-operator
    // guard, act on the registration the operator names in the path, and never select the request's active context. Only this
    // exact statement is exempt, only in that file; anything else there that reads an id from the request still fails.
    const EXEMPT = [{ path: "agent-server/src/routes/platform.route.ts", statement: "const registrationId = String(req.params.id);" }];
    const withoutExempt = (f: { path: string; text: string }) =>
      EXEMPT.filter((e) => e.path === f.path).reduce((text, e) => text.split(e.statement).join(""), f.text);
    for (const e of EXEMPT) {
      // A stale exemption is removed, not left to cover something new.
      expect(sources.find((f) => f.path === e.path)?.text.includes(e.statement), `${e.path} no longer contains the exempt statement`).toBe(true);
    }
    const offenders = sources
      .filter((f) => f.path.startsWith("agent-server/src/routes/") && !isTest(f.path))
      .filter((f) => reads.test(withoutExempt(f)))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  describe("table placement in tenant files (spec 8.4, amendment A1)", () => {
    const MIGRATIONS = join(ROOT, "infrastructure", "src", "database", "migrations");
    const migrations = () => readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).map((name) => ({ name, sql: readFileSync(join(MIGRATIONS, name), "utf8") }));

    it("every table the tenant-file migrations leave is a tenant-data table or an exempt one, and every tenant-data table has its tenant column", () => {
      expect(placementOffenders(migratedTables(migrations()), TENANT_DATA_TABLES, TENANT_EXEMPT_TABLES)).toEqual([]);
    });

    it("every exemption and every tenant-data table names its reason", () => {
      for (const [name, why] of Object.entries(TENANT_EXEMPT_TABLES)) expect(why.trim(), name).not.toBe("");
      for (const [name, t] of Object.entries(TENANT_DATA_TABLES)) expect(t.why.trim(), name).not.toBe("");
    });

    it("the repository that writes each tenant-data table asserts the tenant against the handle", () => {
      const offenders: string[] = [];
      for (const [name, t] of Object.entries(TENANT_DATA_TABLES)) {
        const text = sources.find((f) => f.path === `infrastructure/src/database/repositories/${t.repository}`)?.text ?? "";
        if (!new RegExp(String.raw`INSERT INTO ${name}\s*\(`).test(text)) offenders.push(`${name}: ${t.repository} does not write it`);
        const asserted =
          t.column === "tenant_id"
            ? new RegExp(String.raw`assertRowTenant\(this\.context,[^;]*"${name}"\)`).test(text)
            : // Every public method of the config repository starts with the guard.
              /new TenantMismatchError\(/.test(text) && [...text.matchAll(/^ {2}(?:get|list|save|history)\([^)]*\)[^{]*\{\s*\n\s*this\.guard\(/gm)].length === 4;
        if (!asserted) offenders.push(`${name}: ${t.repository} does not assert the tenant`);
      }
      expect(offenders).toEqual([]);
    });

    it("the placement check catches an unlisted table, a tenant-data table without its column, a renamed or dropped table, and a stale entry", () => {
      const tables = migratedTables([
        { name: "002.sql", sql: "ALTER TABLE b_old RENAME TO b; DROP TABLE gone; ALTER TABLE late ADD COLUMN tenant_id TEXT;" },
        {
          name: "001.sql",
          sql: "CREATE TABLE IF NOT EXISTS a (id TEXT, tenant_id TEXT);\nCREATE TABLE b_old (id TEXT);\nCREATE TABLE gone (id TEXT);\nCREATE TABLE late (id TEXT);\n-- CREATE TABLE commented (id TEXT);\nCREATE TABLE stray (id TEXT, CHECK (id IN ('x')));",
        },
      ]);
      expect([...tables.keys()].sort()).toEqual(["a", "b", "late", "stray"]);

      const data = (column: "tenant_id" | "owner_id"): TenantTable => ({ column, repository: "r.ts", why: "w" });
      expect(placementOffenders(tables, { a: data("tenant_id"), b: data("tenant_id"), late: data("tenant_id") }, { gone: "w" })).toEqual([
        "stray: on neither list (spec 8.4: add it to the tenant-data tables or the exempt tables)",
        "gone: listed, but no migration leaves this table",
        "b: a tenant-data table without tenant_id",
      ]);
      expect(placementOffenders(tables, { a: data("owner_id"), b: data("tenant_id"), late: data("tenant_id") }, { b: "w", stray: "w" })).toEqual([
        "b: on both lists",
        "a: a tenant-data table without owner_id",
        "b: a tenant-data table without tenant_id",
      ]);
    });
  });
});

