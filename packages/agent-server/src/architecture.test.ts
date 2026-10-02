import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
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

describe("architecture", () => {
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
    const offenders = ["domain", "application", "infrastructure", "agent-server"]
      .flatMap((pkg) => sourceFiles(join(ROOT, pkg, "src")))
      .filter((f) => /import[^;]*\bCalendarWriter\b[^;]*from/.test(readFileSync(f, "utf8")))
      .map((f) => posix(relative(ROOT, f)))
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
});
