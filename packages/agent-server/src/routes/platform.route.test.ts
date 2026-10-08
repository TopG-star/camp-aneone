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
  TenantRegistrationRepository,
  openControlDb,
  rawDb,
} from "@oneon/infrastructure";
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

  function setup(opts: { masterKey?: string | null; operator?: boolean } = {}) {
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
        createTenantFile: (id, tenantId) => void gate.createTenantFile(id, tenantId),
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

  it("fails with a bare 500 when the signing master key is not configured", async () => {
    const { app, fake, control } = setup({ masterKey: null });
    const res = await request(app).post("/api/platform/enrolments").send(body);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error" });
    expect(fake.active).toBe(false);
    expect(control.prepare("SELECT COUNT(*) AS n FROM tenant_registrations").get()).toEqual({ n: 0 });
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
});
