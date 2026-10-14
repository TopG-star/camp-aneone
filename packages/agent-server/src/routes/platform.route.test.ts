import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ContextDbGate,
  EnrolmentService,
  FakeImpressorx,
  PlatformOperatorRepository,
  SqliteIdentityRepository,
  TenantRefusedError,
  TenantRegistrationRepository,
  openControlDb,
  rawDb,
} from "@oneon/infrastructure";
import { latestRollups } from "../tenant-jobs.js";
import { createPlatformRouter } from "./platform.route.js";

const ORIGIN = "https://acme.example";
const CODE = "ABCD-EFGH-JKLM";
const body = { origin: ORIGIN, tenantSlug: "acme", code: CODE };

describe("platform route", () => {
  const dirs: string[] = [];
  const closers: Array<() => void> = [];
  afterEach(() => {
    for (const close of closers.splice(0)) close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup(
    opts: { masterKey?: string | null; operator?: boolean; backupConfigured?: boolean; grantConfigured?: boolean; createTenantFile?: (id: string, tenantId: string) => void } = {},
  ) {
    const dir = mkdtempSync(join(tmpdir(), "platform-"));
    dirs.push(dir);
    const control = openControlDb(join(dir, "control.db"));
    const gate = new ContextDbGate({ control, personalPath: join(dir, "personal.db"), tenantDir: join(dir, "tenants") });
    closers.push(() => gate.close(), () => control.close());
    const identities = new SqliteIdentityRepository(control);
    const operatorId = identities.createWithLogin({ kind: "google", subject: "op" }).id;
    const otherId = identities.createWithLogin({ kind: "google", subject: "other" }).id;
    const operators = new PlatformOperatorRepository(control);
    if (opts.operator !== false) operators.grant(operatorId);
    const registrations = new TenantRegistrationRepository(control);
    const fake = new FakeImpressorx(ORIGIN, "acme", CODE);
    const enrolment = new EnrolmentService({
      repo: registrations,
      oneonOrigin: "https://oneon.example",
      masterKeyB64: opts.masterKey === null ? undefined : (opts.masterKey ?? randomBytes(32).toString("base64")),
      fetchImpl: fake.fetch,
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const app = express();
    app.use(express.json());
    let identityId = operatorId;
    app.use((req, _res, next) => {
      req.identityId = identityId;
      next();
    });
    app.use(
      "/api/platform",
      createPlatformRouter({
        operators,
        registrations,
        enrolment,
        backupConfigured: opts.backupConfigured ?? true,
        grantConfigured: opts.grantConfigured ?? true,
        latestRollups: () => latestRollups(control),
        createTenantFile: opts.createTenantFile ?? ((id, tenantId) => void gate.createTenantFile(id, tenantId)),
        logger,
      }),
    );
    return { app, control, gate, fake, registrations, logger, dir, actAs: (id: string) => (identityId = id), otherId };
  }

  it("enrols against the fake deployment", async () => {
    const { app, control, gate, dir } = setup();
    const res = await request(app).post("/api/platform/enrolments").send(body);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ registrationId: expect.any(String), tenantSlug: "acme" });
    const id = res.body.registrationId as string;
    expect(control.prepare("SELECT status FROM tenant_registrations WHERE id = ?").get(id)).toEqual({ status: "active" });
    expect(existsSync(join(dir, "tenants", `${id}.db`))).toBe(true);
    const meta = rawDb(gate.openTenant(id)).prepare("SELECT tenant_id FROM context_meta").get();
    expect(meta).toEqual({ tenant_id: id });
  });

  describe("GET /api/platform/tenants", () => {
    it("lists registrations with their latest rollups and never opens a tenant file", async () => {
      const { app, control, gate, registrations } = setup();
      await request(app).post("/api/platform/enrolments").send(body);
      const reg = registrations.listActive()[0]!;
      control
        .prepare("INSERT INTO tenant_rollups (tenant_id, day, metrics_json) VALUES (?, '2026-10-08', '{}'), (?, '2026-10-09', ?)")
        .run(reg.tenantId, reg.tenantId, JSON.stringify({ modelCalls: 3, modelDenials: 1, actionsByStatus: { completed: 2 }, activeGrants: 1 }));
      const openTenant = vi.spyOn(gate, "openTenant");
      const lease = vi.spyOn(gate, "lease");

      const res = await request(app).get("/api/platform/tenants");

      expect(res.status).toBe(200);
      expect(res.body.tenants).toEqual([
        {
          id: reg.id,
          tenantSlug: "acme",
          displayName: reg.displayName,
          origin: ORIGIN,
          enrolledAt: reg.enrolledAt,
          status: "active",
          latestRollup: { day: "2026-10-09", metrics: { modelCalls: 3, modelDenials: 1, actionsByStatus: { completed: 2 }, activeGrants: 1 } },
        },
      ]);
      expect(openTenant).not.toHaveBeenCalled();
      expect(lease).not.toHaveBeenCalled();
    });

    it("gives a registration with no rollup yet a null latestRollup", async () => {
      const { app } = setup();
      await request(app).post("/api/platform/enrolments").send(body);
      const res = await request(app).get("/api/platform/tenants");
      expect(res.body.tenants[0].latestRollup).toBeNull();
    });

    it("is refused for non-operators", async () => {
      const { app, otherId, actAs } = setup();
      actAs(otherId);
      const res = await request(app).get("/api/platform/tenants");
      expect(res.status).toBe(403);
    });
  });

  it("refuses a non-operator", async () => {
    const { app, otherId, actAs, fake } = setup();
    actAs(otherId);
    const res = await request(app).post("/api/platform/enrolments").send(body);
    expect(res.status).toBe(403);
    expect(fake.active).toBe(false);
  });

  it("refuses an http origin", async () => {
    const { app, fake } = setup();
    const res = await request(app).post("/api/platform/enrolments").send({ ...body, origin: "http://acme.example" });
    expect(res.status).toBe(400);
    expect(fake.active).toBe(false);
  });

  it("reports a reply signed by the wrong key as failure and stores nothing", async () => {
    const { app, control, fake, dir, logger } = setup();
    fake.signReplyWithWrongKey = true;
    const res = await request(app).post("/api/platform/enrolments").send(body);

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "Enrolment failed" });
    expect(control.prepare("SELECT COUNT(*) AS n FROM tenant_registrations").get()).toEqual({ n: 0 });
    expect(existsSync(join(dir, "tenants"))).toBe(false);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(CODE);
  });

  it("fails when the reply names a different tenant than the one entered", async () => {
    const { app, control, fake } = setup();
    fake.replyTenantSlug = "other-pharmacy";
    const res = await request(app).post("/api/platform/enrolments").send(body);
    expect(res.status).toBe(502);
    expect(control.prepare("SELECT COUNT(*) AS n FROM tenant_registrations").get()).toEqual({ n: 0 });
  });

  it("refuses with 503 naming ONEON_SIGNING_KEY_MASTER_KEY when it is not set, before spending the code or writing anything", async () => {
    const { app, fake, control, dir } = setup({ masterKey: null });
    const res = await request(app).post("/api/platform/enrolments").send(body);
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/ONEON_SIGNING_KEY_MASTER_KEY/);
    expect(res.body.error).not.toMatch(/ONEON_GRANT_MASTER_KEY|BACKUP_ENCRYPTION_KEY/);
    expect(fake.active).toBe(false);
    expect(control.prepare("SELECT COUNT(*) AS n FROM tenant_registrations").get()).toEqual({ n: 0 });
    expect(existsSync(join(dir, "tenants"))).toBe(false);
  });

  it("refuses with 503 naming ONEON_GRANT_MASTER_KEY when it is not set (every hand-off would fail), before spending the code", async () => {
    const { app, fake, control, dir } = setup({ grantConfigured: false });
    const res = await request(app).post("/api/platform/enrolments").send(body);
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/ONEON_GRANT_MASTER_KEY/);
    expect(fake.active).toBe(false);
    expect(control.prepare("SELECT COUNT(*) AS n FROM tenant_registrations").get()).toEqual({ n: 0 });
    expect(existsSync(join(dir, "tenants"))).toBe(false);
  });

  it("names every missing key at once", async () => {
    const { app } = setup({ masterKey: null, grantConfigured: false, backupConfigured: false });
    const res = await request(app).post("/api/platform/enrolments").send(body);
    expect(res.status).toBe(503);
    for (const key of ["BACKUP_ENCRYPTION_KEY", "ONEON_SIGNING_KEY_MASTER_KEY", "ONEON_GRANT_MASTER_KEY"]) expect(res.body.error).toContain(key);
  });

  it("refuses to enrol while BACKUP_ENCRYPTION_KEY is unset, before spending the code or writing anything", async () => {
    const { app, control, fake, dir } = setup({ backupConfigured: false });
    const res = await request(app).post("/api/platform/enrolments").send(body);
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/BACKUP_ENCRYPTION_KEY/);
    expect(fake.active).toBe(false); // the code was not spent
    expect(control.prepare("SELECT COUNT(*) AS n FROM tenant_registrations").get()).toEqual({ n: 0 });
    expect(existsSync(join(dir, "tenants"))).toBe(false);
  });

  it("refuses a second enrolment of the same tenant", async () => {
    const { app } = setup();
    expect((await request(app).post("/api/platform/enrolments").send(body)).status).toBe(201);
    expect((await request(app).post("/api/platform/enrolments").send(body)).status).toBe(409);
  });

  it("lists registrations and rotates a key from the console", async () => {
    const { app, fake } = setup();
    const id = (await request(app).post("/api/platform/enrolments").send(body)).body.registrationId as string;
    const list = await request(app).get("/api/platform/registrations");
    expect(list.body.registrations).toEqual([expect.objectContaining({ id, tenantSlug: "acme", origin: ORIGIN })]);

    expect((await request(app).post(`/api/platform/registrations/${id}/rotate-key`)).status).toBe(204);
    expect(fake.oneonKeys).toHaveLength(2);
  });

  describe("operator Suspend and Resume (spec §5.5)", () => {
    const events = (control: ReturnType<typeof openControlDb>, id: string) =>
      control
        .prepare("SELECT event, actor_identity_id AS actor, detail_json AS detail FROM tenant_registration_events WHERE tenant_registration_id = ? AND event = 'status_changed' ORDER BY created_at, rowid")
        .all(id)
        .map((e) => ({ ...(e as { event: string; actor: string; detail: string }), detail: JSON.parse((e as { detail: string }).detail) }));

    it("suspends an active pharmacy: the gate refuses even its cached handle at once, an event and a log line are written", async () => {
      const { app, control, gate, logger } = setup();
      const id = (await request(app).post("/api/platform/enrolments").send(body)).body.registrationId as string;
      gate.openTenant(id); // cached

      const res = await request(app).post(`/api/platform/registrations/${id}/suspend`);

      expect(res.status).toBe(204);
      expect(control.prepare("SELECT status FROM tenant_registrations WHERE id = ?").get(id)).toEqual({ status: "suspended_by_operator" });
      expect(() => gate.openTenant(id)).toThrow(TenantRefusedError);
      expect(events(control, id)).toEqual([{ event: "status_changed", actor: expect.any(String), detail: { from: "active", to: "suspended_by_operator", reason: "operator_suspend" } }]);
      expect(logger.info).toHaveBeenCalledWith("Pharmacy suspended by operator", { registrationId: id });
    });

    it("resumes a suspended pharmacy, and the gate serves it again", async () => {
      const { app, control, gate, logger } = setup();
      const id = (await request(app).post("/api/platform/enrolments").send(body)).body.registrationId as string;
      await request(app).post(`/api/platform/registrations/${id}/suspend`);

      const res = await request(app).post(`/api/platform/registrations/${id}/resume`);

      expect(res.status).toBe(204);
      expect(control.prepare("SELECT status FROM tenant_registrations WHERE id = ?").get(id)).toEqual({ status: "active" });
      expect(rawDb(gate.openTenant(id)).prepare("SELECT tenant_id FROM context_meta").get()).toEqual({ tenant_id: id });
      expect(events(control, id).map((e) => e.detail)).toEqual([
        { from: "active", to: "suspended_by_operator", reason: "operator_suspend" },
        { from: "suspended_by_operator", to: "active", reason: "operator_resume" },
      ]);
      expect(logger.info).toHaveBeenCalledWith("Pharmacy resumed by operator", { registrationId: id });
    });

    it("refuses a suspend that is not from active, and a resume that is not from an operator suspension, with 409 and no event", async () => {
      const { app, control } = setup();
      const id = (await request(app).post("/api/platform/enrolments").send(body)).body.registrationId as string;
      expect((await request(app).post(`/api/platform/registrations/${id}/resume`)).status).toBe(409);
      await request(app).post(`/api/platform/registrations/${id}/suspend`);
      expect((await request(app).post(`/api/platform/registrations/${id}/suspend`)).status).toBe(409);
      expect(events(control, id)).toHaveLength(1);
    });

    it("answers 404 for an unknown registration and 403 for a non-operator", async () => {
      const { app, control, otherId, actAs } = setup();
      expect((await request(app).post("/api/platform/registrations/nope/suspend")).status).toBe(404);
      const id = (await request(app).post("/api/platform/enrolments").send(body)).body.registrationId as string;
      actAs(otherId);
      expect((await request(app).post(`/api/platform/registrations/${id}/suspend`)).status).toBe(403);
      expect(control.prepare("SELECT status FROM tenant_registrations WHERE id = ?").get(id)).toEqual({ status: "active" });
    });

    it("lists a suspended pharmacy in the platform view with its status, so it can be resumed", async () => {
      const { app } = setup();
      const id = (await request(app).post("/api/platform/enrolments").send(body)).body.registrationId as string;
      await request(app).post(`/api/platform/registrations/${id}/suspend`);
      const res = await request(app).get("/api/platform/tenants");
      expect(res.body.tenants).toEqual([expect.objectContaining({ id, status: "suspended_by_operator" })]);
    });
  });

  it("leaves no registration, keys, events or file when creating the tenant file fails,", async () => {
    let fail = true;
    const { app, control, fake, dir } = setup({
      createTenantFile: () => {
        if (fail) throw new Error("disk full");
      },
    });
    const first = await request(app).post("/api/platform/enrolments").send(body);
    expect(first.status).toBe(500);
    for (const table of ["tenant_registrations", "tenant_keys", "tenant_registration_events"]) {
      expect(control.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
    expect(existsSync(join(dir, "tenants"))).toBe(false);
    expect(fake.active).toBe(true); // the code is spent; the operator needs a fresh one
    fail = false;
  });
});
