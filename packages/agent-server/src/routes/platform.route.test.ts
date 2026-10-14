import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  StructuredLogger,
  TenantRefusedError,
  TenantRegistrationRepository,
  createDatabase,
  decryptBackup,
  latestMigrationVersion,
  migrateTenantFile,
  openControlDb,
  rawDb,
} from "@oneon/infrastructure";
import type { Logger } from "@oneon/domain";
import { latestRollups } from "../tenant-jobs.js";
import { createPlatformRouter } from "./platform.route.js";

const ORIGIN = "https://acme.example";
const CODE = "ABCD-EFGH-JKLM";
const body = { origin: ORIGIN, tenantSlug: "acme", code: CODE };
/** Every refusal after the code is spent says this (review I2): ImpressoRx issues no new code while it shows Oneon as connected. */
const CONNECTED = /ImpressoRx now shows Oneon as connected on its side\. The pharmacy's ImpressoRx admin must press Remove, then Enable, to issue a new code\./;

describe("platform route", () => {
  const dirs: string[] = [];
  const closers: Array<() => void> = [];
  afterEach(() => {
    for (const close of closers.splice(0)) close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup(
    opts: {
      masterKey?: string | null;
      operator?: boolean;
      backupConfigured?: boolean;
      grantConfigured?: boolean;
      createTenantFile?: (id: string, tenantId: string) => void;
      logger?: Logger;
    } = {},
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
    const masterKey = opts.masterKey === null ? undefined : (opts.masterKey ?? randomBytes(32).toString("base64"));
    // `onNextAnswer(fn)`: fn runs once the deployment has answered the next request (the code is spent) and before Oneon reads the answer.
    let afterAnswer: (() => unknown) | null = null;
    const onNextAnswer = (fn: () => unknown) => (afterAnswer = fn);
    const fakes = [fake];
    const fetchImpl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const target = fakes.find((f) => new URL(input.toString()).origin === f.origin) ?? fake;
      const res = await target.fetch(input, init);
      const hook = afterAnswer;
      afterAnswer = null;
      await hook?.();
      return res;
    };
    const enrolment = new EnrolmentService({ repo: registrations, oneonOrigin: "https://oneon.example", masterKeyB64: masterKey, fetchImpl });
    const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const logger = opts.logger ?? mockLogger;
    // Production wires the ImpressoRx client's revokeForRegistration (tested with the client); here the same SQL effect.
    const revokeGrantsForRegistration = vi.fn((registrationId: string, reason: string) =>
      void control
        .prepare("UPDATE delegation_grants SET status = 'revoked', revoked_reason = ? WHERE tenant_registration_id = ? AND status = 'active'")
        .run(reason, registrationId),
    );
    // A pharmacy file is backed up (sealed) before Resume or re-enrolment migrates it, into pre-migration/2026-10-14T05-06-07Z/.
    const backupKey = randomBytes(32).toString("base64");
    const preMigrationBackup = { outDir: join(dir, "backups"), keyB64: backupKey, now: () => new Date("2026-10-14T05:06:07.000Z"), scratchDir: join(dir, "scratch") };
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
        detachTenant: (id) => gate.detach(id),
        revokeGrantsForRegistration,
        migrateTenantFile: (registration) => migrateTenantFile({ gate, backup: preMigrationBackup }, registration),
        logger,
      }),
    );
    return { app, control, gate, fake, registrations, enrolment, masterKey, logger: mockLogger, dir, actAs: (id: string) => (identityId = id), otherId, operatorId, revokeGrantsForRegistration, onNextAnswer, fakes, backupKey };
  }

  it("enrols against the fake deployment", async () => {
    const { app, control, gate, dir } = setup();
    const res = await request(app).post("/api/platform/enrolments").send(body);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ registrationId: expect.any(String), tenantSlug: "acme" });
    const id = res.body.registrationId as string;
    expect(control.prepare("SELECT status FROM tenant_registrations WHERE id = ?").get(id)).toEqual({ status: "active" });
    expect(existsSync(join(dir, "tenants", `${id}.db`))).toBe(true);
    const meta = rawDb(gate.lease(id).db).prepare("SELECT tenant_id FROM context_meta").get();
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
      const lease = vi.spyOn(gate, "lease");

      const res = await request(app).get("/api/platform/tenants");

      expect(res.status).toBe(200);
      expect(res.body.tenants).toEqual([
        {
          id: reg.id,
          tenantSlug: "acme",
          impressorxTenantId: reg.impressorxTenantId,
          displayName: reg.displayName,
          origin: ORIGIN,
          enrolledAt: reg.enrolledAt,
          status: "active",
          latestRollup: { day: "2026-10-09", metrics: { modelCalls: 3, modelDenials: 1, actionsByStatus: { completed: 2 }, activeGrants: 1 } },
        },
      ]);
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
      gate.withTenant(id, () => undefined); // cached

      const res = await request(app).post(`/api/platform/registrations/${id}/suspend`);

      expect(res.status).toBe(204);
      expect(control.prepare("SELECT status FROM tenant_registrations WHERE id = ?").get(id)).toEqual({ status: "suspended_by_operator" });
      expect(() => gate.lease(id).db).toThrow(TenantRefusedError);
      expect(events(control, id)).toEqual([{ event: "status_changed", actor: expect.any(String), detail: { from: "active", to: "suspended_by_operator", reason: "operator_suspend" } }]);
      expect(logger.info).toHaveBeenCalledWith("Pharmacy suspended by operator", { registrationId: id });
    });

    it("suspending closes the pharmacy's unleased handle at once, and a leased one at its last release, with no lease attempt in between", async () => {
      const { app, gate } = setup();
      const id = (await request(app).post("/api/platform/enrolments").send(body)).body.registrationId as string;
      const unleased = gate.withTenant(id, (db) => db); // cached, nobody using it
      expect(rawDb(unleased).open).toBe(true);
      await request(app).post(`/api/platform/registrations/${id}/suspend`);
      expect(rawDb(unleased).open).toBe(false);

      await request(app).post(`/api/platform/registrations/${id}/resume`);
      const lease = gate.lease(id);
      await request(app).post(`/api/platform/registrations/${id}/suspend`);
      expect(rawDb(lease.db).open).toBe(true);
      lease.release();
      expect(rawDb(lease.db).open).toBe(false);
    });

    it("a refused suspend leaves the pharmacy's handle alone", async () => {
      const { app, gate } = setup();
      const id = (await request(app).post("/api/platform/enrolments").send(body)).body.registrationId as string;
      const db = gate.withTenant(id, (d) => d);
      await request(app).post(`/api/platform/registrations/${id}/resume`); // 409: it is not suspended
      expect(rawDb(db).open).toBe(true);
    });

    it("resumes a suspended pharmacy, and the gate serves it again", async () => {
      const { app, control, gate, logger } = setup();
      const id = (await request(app).post("/api/platform/enrolments").send(body)).body.registrationId as string;
      await request(app).post(`/api/platform/registrations/${id}/suspend`);

      const res = await request(app).post(`/api/platform/registrations/${id}/resume`);

      expect(res.status).toBe(204);
      expect(control.prepare("SELECT status FROM tenant_registrations WHERE id = ?").get(id)).toEqual({ status: "active" });
      expect(rawDb(gate.lease(id).db).prepare("SELECT tenant_id FROM context_meta").get()).toEqual({ tenant_id: id });
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

  it("never writes the enrolment code or any key material to the log, across failed and successful enrolments (spec I6)", async () => {
    const written: string[] = [];
    const capture = (chunk: unknown) => (written.push(String(chunk)), true);
    const out = vi.spyOn(process.stdout, "write").mockImplementation(capture);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(capture);
    try {
      const logger = new StructuredLogger("platform", "debug");
      // A reply the deployment signed with the wrong key (logged as a warning), a storage error (logged as an error), then success.
      const wrongKey = setup({ logger });
      wrongKey.fake.signReplyWithWrongKey = true;
      expect((await request(wrongKey.app).post("/api/platform/enrolments").send(body)).status).toBe(502);
      const diskFull = setup({
        logger,
        createTenantFile: () => {
          throw new Error("disk full");
        },
      });
      expect((await request(diskFull.app).post("/api/platform/enrolments").send(body)).status).toBe(500);
      const good = setup({ logger });
      const ok = await request(good.app).post("/api/platform/enrolments").send(body);
      expect(ok.status).toBe(201);

      const log = written.join("");
      expect(log).toContain("Enrolment failed");
      expect(log).toContain("Enrolment error");
      const { privateKeyJwk } = await good.enrolment.oneonSigningKey(ok.body.registrationId as string);
      const secrets = [CODE, wrongKey.masterKey!, diskFull.masterKey!, good.masterKey!, privateKeyJwk.d as string, JSON.stringify(privateKeyJwk)];
      for (const secret of secrets) expect(log).not.toContain(secret);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });

  describe("re-enrolment of a suspended pharmacy (ruling: same origin, same signed slug, keys replaced at once)", () => {
    const CODE2 = "NEW1-CODE-2222";
    const NOW = "2026-10-14T00:00:00.000Z";

    /** An enrolled pharmacy with a member, an active grant and a row in its file, suspended, whose admin pressed Remove then Enable. */
    async function suspendedWithRemoveAndEnable() {
      const s = setup();
      const id = (await request(s.app).post("/api/platform/enrolments").send(body)).body.registrationId as string;
      const oldHandoff = await s.fake.mintHandoff("staff-1"); // signed by the deployment key of the first enrolment
      const oldOneonKeyIds = s.enrolment.oneonSigningKeys(id).map((k) => k.keyId);
      s.control
        .prepare(
          "INSERT INTO memberships (id, identity_id, tenant_registration_id, external_user_id, role, permissions_json, location_ids_json, status, snapshot_at, created_at) VALUES ('m-1', ?, ?, 'staff-1', 'Manager', '[]', '[]', 'suspended', ?, ?)",
        )
        .run(s.otherId, id, NOW, NOW);
      s.control
        .prepare(
          "INSERT INTO delegation_grants (id, identity_id, membership_id, tenant_registration_id, kind, scope_json, encrypted_value, wrapped_key, generation, status, created_at, absolute_expires_at) VALUES ('g-1', ?, 'm-1', ?, 'attended', '[]', 'x', 'x', 1, 'active', ?, '2099-01-01T00:00:00.000Z')",
        )
        .run(s.otherId, id, NOW);
      rawDb(s.gate.lease(id).db).prepare("INSERT INTO users (id, email) VALUES ('kept', 'kept@anchor.invalid')").run();
      expect((await request(s.app).post(`/api/platform/registrations/${id}/suspend`)).status).toBe(204);
      s.fake.removeAndEnable(CODE2);
      const status = () => (s.control.prepare("SELECT status FROM tenant_registrations WHERE id = ?").get(id) as { status: string }).status;
      const keyRows = () => s.control.prepare("SELECT key_id, retired_at FROM tenant_keys WHERE tenant_registration_id = ? ORDER BY rowid").all(id);
      const grantStatus = () => s.control.prepare("SELECT status, revoked_reason FROM delegation_grants WHERE id = 'g-1'").get();
      return { ...s, id, oldHandoff, oldOneonKeyIds, status, keyRows, grantStatus };
    }

    it("replaces both keys at once, revokes the grants, keeps file, tenant id and memberships, and reactivates", async () => {
      const s = await suspendedWithRemoveAndEnable();

      const res = await request(s.app).post("/api/platform/enrolments").send({ ...body, code: CODE2 });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ registrationId: s.id, tenantSlug: "acme", reenrolled: true });
      expect(s.status()).toBe("active");
      expect(s.control.prepare("SELECT COUNT(*) AS n FROM tenant_registrations").get()).toEqual({ n: 1 });
      expect(s.control.prepare("SELECT tenant_id, impressorx_tenant_id FROM tenant_registrations WHERE id = ?").get(s.id)).toEqual({
        tenant_id: s.id,
        impressorx_tenant_id: s.fake.impressorxTenantId,
      });
      expect(rawDb(s.gate.lease(s.id).db).prepare("SELECT id FROM users WHERE id = 'kept'").get()).toEqual({ id: "kept" });
      // The membership is kept as it was; it reactivates through the normal hand-off snapshot path.
      expect(s.control.prepare("SELECT id, status FROM memberships").all()).toEqual([{ id: "m-1", status: "suspended" }]);
      expect(s.grantStatus()).toEqual({ status: "revoked", revoked_reason: "reenrolled" });
      const events = s.control
        .prepare("SELECT event, detail_json FROM tenant_registration_events WHERE tenant_registration_id = ? ORDER BY created_at, rowid")
        .all(s.id) as Array<{ event: string; detail_json: string }>;
      expect(events.slice(-2).map((e) => [e.event, JSON.parse(e.detail_json).to ?? null])).toEqual([
        ["reenrolled", null],
        ["status_changed", "active"],
      ]);
      expect(s.logger.info).toHaveBeenCalledWith("Pharmacy re-enrolled", { registrationId: s.id });

      // Old keys: every key of the first enrolment is retired now; Oneon signs only with the new key, which the deployment holds.
      const newOneon = s.enrolment.oneonSigningKeys(s.id).map((k) => k.keyId);
      expect(newOneon).toHaveLength(1);
      expect(s.oldOneonKeyIds).not.toContain(newOneon[0]);
      expect(s.fake.oneonKeys.map((k) => k.keyId)).toEqual(newOneon);
      expect(s.registrations.deploymentKeys(s.id)).toHaveLength(1);
      await expect(s.enrolment.verifyFromDeployment(s.id, s.oldHandoff, { audience: "oneon" })).rejects.toThrow();
      await expect(s.enrolment.verifyFromDeployment(s.id, await s.fake.mintHandoff("staff-1"), { audience: "oneon" })).resolves.toBeTruthy();
    });

    it("answers 409 for a slug whose registration is active, before spending the code", async () => {
      const s = setup();
      await request(s.app).post("/api/platform/enrolments").send(body);
      s.fake.removeAndEnable(CODE2);

      const res = await request(s.app).post("/api/platform/enrolments").send({ ...body, code: CODE2 });

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/already enrolled.*Suspend it first/i);
      expect(s.fake.active).toBe(false);
    });

    it("refuses another origin with a clear message, before spending the code, and changes nothing", async () => {
      const s = await suspendedWithRemoveAndEnable();
      const keysBefore = s.keyRows();

      const res = await request(s.app).post("/api/platform/enrolments").send({ ...body, origin: "https://acme-new.example", code: CODE2 });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain(ORIGIN);
      expect(res.body.error).toMatch(/same origin/i);
      expect(s.fake.active).toBe(false);
      expect(s.status()).toBe("suspended_by_operator");
      expect(s.keyRows()).toEqual(keysBefore);
      expect(s.grantStatus()).toEqual({ status: "active", revoked_reason: null });
    });

    it("refuses a pharmacy set up again under the same slug (another ImpressoRx tenant id), and changes nothing", async () => {
      const s = await suspendedWithRemoveAndEnable();
      const keysBefore = s.keyRows();
      // Deleted and recreated: a new database, so a new Tenant.id, behind the same slug and origin.
      s.fake.impressorxTenantId = randomUUID();

      const res = await request(s.app).post("/api/platform/enrolments").send({ ...body, code: CODE2 });

      expect(res.status).toBe(502);
      expect(res.body.error).toMatch(/different pharmacy from the one enrolled as acme/i);
      expect(s.status()).toBe("suspended_by_operator");
      expect(s.keyRows()).toEqual(keysBefore);
      expect(s.grantStatus()).toEqual({ status: "active", revoked_reason: null });
      expect(s.revokeGrantsForRegistration).not.toHaveBeenCalled();
    });

    it("refuses a reply that does not name its ImpressoRx tenant id, saying ImpressoRx needs updating", async () => {
      const s = await suspendedWithRemoveAndEnable();
      s.fake.impressorxTenantId = null;

      const res = await request(s.app).post("/api/platform/enrolments").send({ ...body, code: CODE2 });

      expect(res.status).toBe(502);
      expect(res.body.error).toMatch(/update ImpressoRx/i);
      expect(s.status()).toBe("suspended_by_operator");
    });

    it("refuses a reply signed for another slug with a clear message, and changes nothing", async () => {
      const s = await suspendedWithRemoveAndEnable();
      const keysBefore = s.keyRows();
      s.fake.replyTenantSlug = "other-pharmacy";

      const res = await request(s.app).post("/api/platform/enrolments").send({ ...body, code: CODE2 });

      expect(res.status).toBe(502);
      expect(res.body.error).toMatch(/different pharmacy.*acme/i);
      expect(s.status()).toBe("suspended_by_operator");
      expect(s.keyRows()).toEqual(keysBefore);
      expect(s.grantStatus()).toEqual({ status: "active", revoked_reason: null });
      expect(s.revokeGrantsForRegistration).not.toHaveBeenCalled();
    });

    it("a reply for another pharmacy says ImpressoRx now shows Oneon as connected and its admin must press Remove", async () => {
      const s = await suspendedWithRemoveAndEnable();
      s.fake.impressorxTenantId = randomUUID();
      const res = await request(s.app).post("/api/platform/enrolments").send({ ...body, code: CODE2 });
      expect(res.status).toBe(502);
      expect(res.body.error).toMatch(/ImpressoRx now shows Oneon as connected on its side/);
      expect(res.body.error).toMatch(/press Remove/);
      expect(res.body.error).not.toMatch(/ask for a new/i);
    });

    it("a registration that stopped being suspended while the deployment answered: an explicit 409, nothing stored, not a 500", async () => {
      const s = await suspendedWithRemoveAndEnable();
      const keysBefore = s.keyRows();
      // Another operation moves it while the code is being proved (the conditional UPDATE then matches no row).
      s.onNextAnswer(() => s.control.prepare("UPDATE tenant_registrations SET status = 'active' WHERE id = ?").run(s.id));

      const res = await request(s.app).post("/api/platform/enrolments").send({ ...body, code: CODE2 });

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/no longer suspended/i);
      expect(res.body.error).toMatch(CONNECTED);
      expect(s.fake.active).toBe(true);
      expect(s.keyRows()).toEqual(keysBefore);
      expect(s.grantStatus()).toEqual({ status: "active", revoked_reason: null });
      expect(s.logger.error).not.toHaveBeenCalled();
    });
  });

  describe("Resume reports success only for a servable pharmacy (review I3, owner decision D5)", () => {
    const PRE_MIGRATION = join("backups", "pre-migration", "2026-10-14T05-06-07Z");

    async function suspended() {
      const s = setup();
      const id = (await request(s.app).post("/api/platform/enrolments").send(body)).body.registrationId as string;
      expect((await request(s.app).post(`/api/platform/registrations/${id}/suspend`)).status).toBe(204);
      const path = join(s.dir, "tenants", `${id}.db`);
      const status = () => (s.control.prepare("SELECT status FROM tenant_registrations WHERE id = ?").get(id) as { status: string }).status;
      const refusals = () =>
        (s.control.prepare("SELECT actor_identity_id AS actor, detail_json FROM tenant_registration_events WHERE tenant_registration_id = ? AND event = 'resume_refused'").all(id) as Array<{ actor: string; detail_json: string }>).map(
          (e) => ({ actor: e.actor, ...JSON.parse(e.detail_json) }),
        );
      return { ...s, id, path, status, refusals };
    }

    /** One migration behind: a release that adds migration 17 was deployed while the pharmacy was suspended. */
    const fallBehind = (path: string) => {
      const db = createDatabase(path);
      db.exec(
        "DELETE FROM schema_migrations WHERE version = 17; ALTER TABLE model_call_decisions DROP COLUMN conversation_id; ALTER TABLE model_call_decisions DROP COLUMN turn_id; ALTER TABLE action_instances DROP COLUMN model_call_id;",
      );
      db.close();
    };
    const version = (path: string) => {
      const db = createDatabase(path);
      const v = (db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number }).v;
      db.close();
      return v;
    };

    it("migrates a file that fell behind while suspended, after a sealed copy of it, before it reports success; the gate then serves it", async () => {
      const s = await suspended();
      fallBehind(s.path);

      const res = await request(s.app).post(`/api/platform/registrations/${s.id}/resume`);

      expect(res.status).toBe(204);
      expect(s.status()).toBe("active");
      expect(version(s.path)).toBe(latestMigrationVersion());
      const copy = join(s.dir, PRE_MIGRATION, `${s.id}.db`);
      writeFileSync(copy, decryptBackup(join(s.dir, PRE_MIGRATION, `${s.id}.db.enc`), s.backupKey));
      expect(version(copy)).toBe(latestMigrationVersion() - 1);
      const lease = s.gate.lease(s.id);
      expect(lease.db.tenantId).toBe(s.id);
      lease.release();
    });

    it("refreshes the deployment keys before it reports success, so a key the deployment rotated meanwhile is known", async () => {
      const s = await suspended();
      const rotated = await s.fake.rotateDeploymentKey();

      const res = await request(s.app).post(`/api/platform/registrations/${s.id}/resume`);

      expect(res.status).toBe(204);
      expect(s.registrations.deploymentKeys(s.id).map((k) => k.keyId)).toContain(rotated.keyId);
    });

    it("refuses when the file cannot be migrated: it stays suspended, the answer names the step, an event is written, no keys are fetched", async () => {
      const s = await suspended();
      fallBehind(s.path);
      // Something already sits where the sealed copy must go, so the copy fails and the file must not be migrated.
      mkdirSync(join(s.dir, PRE_MIGRATION, `${s.id}.db.enc`), { recursive: true });
      writeFileSync(join(s.dir, PRE_MIGRATION, `${s.id}.db.enc`, "blocker"), "");
      const keysBefore = s.registrations.deploymentKeys(s.id);
      const rotated = await s.fake.rotateDeploymentKey();

      const res = await request(s.app).post(`/api/platform/registrations/${s.id}/resume`);

      expect(res.status).toBe(500);
      expect(res.body.step).toBe("migration");
      expect(res.body.error).toMatch(/could not be brought up to date/);
      expect(res.body.error).toMatch(/stays suspended/);
      expect(s.status()).toBe("suspended_by_operator");
      expect(version(s.path)).toBe(latestMigrationVersion() - 1);
      expect(s.registrations.deploymentKeys(s.id).map((k) => k.keyId)).not.toContain(rotated.keyId);
      expect(s.registrations.deploymentKeys(s.id)).toEqual(keysBefore);
      expect(s.refusals()).toEqual([{ actor: s.operatorId, step: "migration", error: expect.stringMatching(/pre-migration backup failed/) }]);
      expect(s.logger.warn).toHaveBeenCalledWith("Pharmacy resume refused", { registrationId: s.id, step: "migration", error: expect.any(String) });
    });

    it("refuses when the deployment keys cannot be refreshed: it stays suspended, the answer names the step, an event is written", async () => {
      const s = await suspended();
      s.fake.signListWithUnknownKey = true;

      const res = await request(s.app).post(`/api/platform/registrations/${s.id}/resume`);

      expect(res.status).toBe(502);
      expect(res.body.step).toBe("deployment_keys");
      expect(res.body.error).toMatch(/could not refresh/);
      expect(res.body.error).toMatch(/stays suspended/);
      expect(s.status()).toBe("suspended_by_operator");
      expect(s.refusals()).toEqual([{ actor: s.operatorId, step: "deployment_keys", error: expect.any(String) }]);
      expect(() => s.gate.lease(s.id)).toThrow(TenantRefusedError);
    });

    it("Suspend while a Resume waits for the deployment is refused with 409", async () => {
      const s = await suspended();
      let suspend: request.Response | undefined;
      s.onNextAnswer(async () => {
        suspend = await request(s.app).post(`/api/platform/registrations/${s.id}/suspend`);
      });

      const resume = await request(s.app).post(`/api/platform/registrations/${s.id}/resume`);

      expect(resume.status).toBe(204);
      expect(suspend!.status).toBe(409);
      expect(suspend!.body.error).toMatch(/A resume is in progress for this pharmacy/);
    });

    it("re-enrolment migrates the file before the code is spent, and a failed migration refuses with the code unused", async () => {
      const ok = await suspended();
      fallBehind(ok.path);
      ok.fake.removeAndEnable("NEW1-CODE-2222");
      const res = await request(ok.app).post("/api/platform/enrolments").send({ ...body, code: "NEW1-CODE-2222" });
      expect(res.status).toBe(200);
      expect(version(ok.path)).toBe(latestMigrationVersion());

      const bad = await suspended();
      fallBehind(bad.path);
      mkdirSync(join(bad.dir, PRE_MIGRATION, `${bad.id}.db.enc`), { recursive: true });
      writeFileSync(join(bad.dir, PRE_MIGRATION, `${bad.id}.db.enc`, "blocker"), "");
      bad.fake.removeAndEnable("NEW1-CODE-2222");
      const refused = await request(bad.app).post("/api/platform/enrolments").send({ ...body, code: "NEW1-CODE-2222" });
      expect(refused.status).toBe(500);
      expect(refused.body.error).toMatch(/could not be brought up to date/);
      expect(refused.body.error).toMatch(/code is still valid/);
      expect(bad.fake.active).toBe(false);
      expect(bad.status()).toBe("suspended_by_operator");
    });
  });

  describe("one operation per pharmacy at a time (review I2, option b)", () => {
    it("two concurrent first enrolments with the same slug: one succeeds, the other is refused with 409 before its code is spent", async () => {
      const { app, fakes, control, onNextAnswer } = setup();
      // A second deployment that also calls itself acme, at another origin.
      const twin = new FakeImpressorx("https://acme-two.example", "acme", "TWIN-CODE-0001");
      fakes.push(twin);
      let second: request.Response | undefined;
      // The second request arrives while the first one waits for its deployment's answer.
      onNextAnswer(async () => {
        second = await request(app).post("/api/platform/enrolments").send({ origin: "https://acme-two.example", tenantSlug: "acme", code: "TWIN-CODE-0001" });
      });

      const first = await request(app).post("/api/platform/enrolments").send(body);

      expect(first.status).toBe(201);
      expect(second!.status).toBe(409);
      expect(second!.body.error).toMatch(/An enrolment is in progress for this pharmacy/);
      expect(second!.body.error).toMatch(/code is still valid/);
      expect(twin.active).toBe(false);
      expect(control.prepare("SELECT origin FROM tenant_registrations").all()).toEqual([{ origin: ORIGIN }]);
    });

    it("Resume during an in-flight re-enrolment is refused with 409, and the re-enrolment completes", async () => {
      const { app, fake, control, onNextAnswer } = setup();
      const id = (await request(app).post("/api/platform/enrolments").send(body)).body.registrationId as string;
      await request(app).post(`/api/platform/registrations/${id}/suspend`);
      fake.removeAndEnable("NEW1-CODE-2222");
      let resume: request.Response | undefined;
      let suspend: request.Response | undefined;
      onNextAnswer(async () => {
        resume = await request(app).post(`/api/platform/registrations/${id}/resume`);
        suspend = await request(app).post(`/api/platform/registrations/${id}/suspend`);
      });

      const reenrol = await request(app).post("/api/platform/enrolments").send({ ...body, code: "NEW1-CODE-2222" });

      expect(resume!.status).toBe(409);
      expect(resume!.body.error).toMatch(/A re-enrolment is in progress for this pharmacy/);
      expect(suspend!.status).toBe(409);
      expect(suspend!.body.error).toMatch(/A re-enrolment is in progress for this pharmacy/);
      expect(reenrol.status).toBe(200);
      expect(control.prepare("SELECT status FROM tenant_registrations WHERE id = ?").get(id)).toEqual({ status: "active" });
    });

    it("the lock is released after a refusal, so the next operation goes ahead", async () => {
      const { app, fake } = setup();
      fake.replyTenantSlug = "other-pharmacy";
      expect((await request(app).post("/api/platform/enrolments").send(body)).status).toBe(502);
      fake.replyTenantSlug = null;
      fake.removeAndEnable("NEW1-CODE-2222");
      expect((await request(app).post("/api/platform/enrolments").send({ ...body, code: "NEW1-CODE-2222" })).status).toBe(201);
    });
  });

  describe("explicit failures after the code is spent (review I2, option a)", () => {
    const expectSpent = (error: string) => {
      expect(error).toMatch(CONNECTED);
      expect(error).not.toMatch(/ask for a new/i);
    };

    it("a reply for another slug: 502, ImpressoRx shows Oneon as connected, the admin presses Remove then Enable", async () => {
      const { app, fake } = setup();
      fake.replyTenantSlug = "other-pharmacy";
      const res = await request(app).post("/api/platform/enrolments").send(body);
      expect(res.status).toBe(502);
      expect(res.body.error).toMatch(/different pharmacy than acme/);
      expectSpent(res.body.error);
    });

    it("a reply that names no ImpressoRx tenant id: 502 with the same advice", async () => {
      const { app, fake } = setup();
      fake.impressorxTenantId = null;
      const res = await request(app).post("/api/platform/enrolments").send(body);
      expect(res.status).toBe(502);
      expect(res.body.error).toMatch(/update ImpressoRx/i);
      expectSpent(res.body.error);
    });

    it("an ImpressoRx tenant id another registration already holds: 409 with the same advice", async () => {
      const { app, fake, fakes, control } = setup();
      expect((await request(app).post("/api/platform/enrolments").send(body)).status).toBe(201);
      // A copy of that pharmacy's database, set up under another slug at another origin.
      const copy = new FakeImpressorx("https://acme-copy.example", "acme-copy", "COPY-CODE-0001");
      copy.impressorxTenantId = fake.impressorxTenantId;
      fakes.push(copy);

      const res = await request(app)
        .post("/api/platform/enrolments")
        .send({ origin: "https://acme-copy.example", tenantSlug: "acme-copy", code: "COPY-CODE-0001" });

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/already enrolled under another slug/);
      expectSpent(res.body.error);
      expect(copy.active).toBe(true);
      expect(control.prepare("SELECT COUNT(*) AS n FROM tenant_registrations").get()).toEqual({ n: 1 });
    });

    it("the tenant file cannot be created: an explicit message and the error logged, never a bare 'Internal server error'", async () => {
      const { app, fake, logger } = setup({
        createTenantFile: () => {
          throw new Error("disk full");
        },
      });
      const res = await request(app).post("/api/platform/enrolments").send(body);
      expect(res.status).toBe(500);
      expect(res.body.error).not.toBe("Internal server error");
      expect(res.body.error).toMatch(/could not be stored/i);
      expectSpent(res.body.error);
      expect(fake.active).toBe(true);
      expect(logger.error).toHaveBeenCalledWith("Enrolment error", { tenantSlug: "acme", error: "disk full" });
    });

    it("the slug registered by another enrolment while the deployment answered: 409 with the advice, not a 500", async () => {
      const { app, control, operatorId, onNextAnswer } = setup();
      onNextAnswer(() =>
        control
          .prepare(
            "INSERT INTO tenant_registrations (id, tenant_id, impressorx_tenant_id, tenant_slug, display_name, origin, file_name, status, enrolled_by, enrolled_at) VALUES ('other', 'other', 'irx-other', 'acme', 'Acme', 'https://acme-two.example', 'other.db', 'active', ?, 'now')",
          )
          .run(operatorId),
      );
      const res = await request(app).post("/api/platform/enrolments").send(body);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/acme/);
      expectSpent(res.body.error);
      expect(control.prepare("SELECT id FROM tenant_registrations").all()).toEqual([{ id: "other" }]);
    });

    it("the ImpressoRx tenant id taken past the in-code check (only a second process could): 409 with the advice, not a 500", async () => {
      const { app, control, fake, registrations, operatorId, onNextAnswer } = setup();
      vi.spyOn(registrations, "findByImpressorxTenantId").mockReturnValue(null);
      onNextAnswer(() =>
        control
          .prepare(
            "INSERT INTO tenant_registrations (id, tenant_id, impressorx_tenant_id, tenant_slug, display_name, origin, file_name, status, enrolled_by, enrolled_at) VALUES ('other', 'other', ?, 'other-slug', 'Other', 'https://other.example', 'other.db', 'active', ?, 'now')",
          )
          .run(fake.impressorxTenantId, operatorId),
      );
      const res = await request(app).post("/api/platform/enrolments").send(body);
      expect(res.status).toBe(409);
      expectSpent(res.body.error);
    });

    it("a signing master key that cannot seal is refused before the code is spent", async () => {
      const { app, fake, control } = setup({ masterKey: Buffer.from("too short").toString("base64") });
      const res = await request(app).post("/api/platform/enrolments").send(body);
      expect(res.status).toBe(500);
      expect(fake.active).toBe(false);
      expect(control.prepare("SELECT COUNT(*) AS n FROM tenant_registrations").get()).toEqual({ n: 0 });
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
