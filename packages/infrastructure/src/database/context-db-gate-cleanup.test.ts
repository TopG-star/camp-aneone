import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const state = { failMeta: false };

// Fails the tenant file's setup after the file exists on disk, to prove the gate removes what it half-wrote.
vi.mock("./connection.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./connection.js")>();
  return {
    ...original,
    latestMigrationVersion: () => {
      if (state.failMeta) throw new Error("injected failure");
      return original.latestMigrationVersion();
    },
  };
});

import { ContextDbGate } from "./context-db-gate.js";
import { openControlDb } from "./control/open-control-db.js";

describe("ContextDbGate.createTenantFile cleanup", () => {
  let dir = "";
  afterEach(() => {
    state.failMeta = false;
    rmSync(dir, { recursive: true, force: true });
  });

  it("removes the half-written file (and wal/shm) when setup fails, so a retry is not blocked", () => {
    dir = mkdtempSync(join(tmpdir(), "gate-cleanup-"));
    const control = openControlDb(join(dir, "control.db"));
    control.prepare("INSERT INTO identities (id, status, created_at) VALUES ('op', 'active', 'x')").run();
    const id = "11111111-1111-1111-1111-111111111111";
    control
      .prepare(
        "INSERT INTO tenant_registrations (id, tenant_id, tenant_slug, display_name, origin, file_name, status, enrolled_by, enrolled_at) VALUES (?, ?, 's', 's', 'https://x.example', ?, 'active', 'op', 'x')",
      )
      .run(id, id, `${id}.db`);
    const gate = new ContextDbGate({ control, personalPath: join(dir, "personal.db"), tenantDir: join(dir, "tenants") });

    state.failMeta = true;
    expect(() => gate.createTenantFile(id, id)).toThrow("injected failure");
    const path = join(dir, "tenants", `${id}.db`);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);

    state.failMeta = false;
    expect(() => gate.createTenantFile(id, id)).not.toThrow();
    gate.close();
    control.close();
  });
});
