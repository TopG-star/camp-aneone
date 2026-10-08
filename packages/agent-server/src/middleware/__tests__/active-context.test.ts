import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Logger, PersonalDb, TenantDb } from "@oneon/domain";
import { TenantRefusedError, createDatabase, runMigrations } from "@oneon/infrastructure";
import { resolveActiveContext } from "../active-context.js";

function logger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function tenantDb(): TenantDb {
  const raw = createDatabase(":memory:");
  runMigrations(raw);
  return { kind: "tenant", tenantId: "tenant-1", raw, __brand: "TenantDb" };
}

function app(deps: { openTenant: (id: string) => TenantDb; log: Logger }) {
  const a = express();
  a.use((req, _res, next) => {
    req.identityId = "i1";
    req.userId = "i1";
    req.sessionId = "s1";
    req.sessionContext = { kind: "tenant", membershipId: "m1" };
    next();
  });
  a.use(
    resolveActiveContext({
      gate: { openPersonal: () => ({}) as PersonalDb, openTenant: deps.openTenant },
      memberships: { findById: () => ({ id: "m1", identityId: "i1", tenantRegistrationId: "reg-1", status: "active" }) as never },
      identities: { hasLogin: () => false },
      logger: deps.log,
    }),
  );
  a.get("/", (req, res) => res.json(req.activeContext));
  return a;
}

describe("resolveActiveContext", () => {
  it("logs a gate refusal with its code and the membership id before answering 403", async () => {
    const log = logger();
    const res = await request(
      app({
        log,
        openTenant: () => {
          throw new TenantRefusedError("tenant_schema_behind");
        },
      }),
    ).get("/");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "context_unavailable" });
    expect(log.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ error: "tenant_schema_behind", membershipId: "m1" }));
  });

  it("logs an unexpected error too", async () => {
    const log = logger();
    const res = await request(
      app({
        log,
        openTenant: () => {
          throw new Error("SQLITE_BUSY");
        },
      }),
    ).get("/");

    expect(res.status).toBe(403);
    expect(log.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ error: "SQLITE_BUSY", membershipId: "m1" }));
  });

  it("a tenant context carries the registration id beside the rows' tenant id", async () => {
    const res = await request(app({ log: logger(), openTenant: () => tenantDb() })).get("/");

    expect(res.body).toEqual({
      kind: "tenant",
      identityId: "i1",
      membershipId: "m1",
      registrationId: "reg-1",
      tenantId: "tenant-1",
    });
  });
});
