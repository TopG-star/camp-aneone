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

  it("only the gate and connection.ts construct a SQLite Database", () => {
    // Every package, not just the four in `sources`.
    const offenders = readdirSync(ROOT)
      .filter((pkg) => existsSync(join(ROOT, pkg, "src")))
      .flatMap((pkg) => sourceFiles(join(ROOT, pkg, "src")))
      .map((f) => posix(relative(ROOT, f)))
      .filter((p) => !isTest(p) && p !== "infrastructure/src/database/connection.ts" && p !== "infrastructure/src/database/context-db-gate.ts")
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

  it("only the gate and connection.ts value-import the SQLite driver", () => {
    const offenders = readdirSync(ROOT)
      .filter((pkg) => existsSync(join(ROOT, pkg, "src")))
      .flatMap((pkg) => sourceFiles(join(ROOT, pkg, "src")))
      .map((f) => posix(relative(ROOT, f)))
      .filter((p) => !isTest(p) && p !== "infrastructure/src/database/connection.ts" && p !== "infrastructure/src/database/context-db-gate.ts")
      .filter((p) => valueImportsSqlite(readFileSync(join(ROOT, p), "utf8")));
    expect(offenders).toEqual([]);
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
});
