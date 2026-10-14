import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TenantAiLimitViewSchema } from "@oneon/contracts";
import type { ActiveContext } from "@oneon/domain";
import {
  Fingerprinter,
  PROVIDER_REGISTRY,
  createModelGateway,
  type ModelProvider,
  type ModelRouting,
  type ProviderEntry,
  type ProviderId,
  type ProviderOverride,
} from "@oneon/application";
import {
  EnrolmentService,
  FakeImpressorx,
  MembershipRepository,
  SqliteIdentityRepository,
  TenantAiLimitRepository,
  TenantRegistrationRepository,
  createImpressoRxClient,
  openControlDb,
} from "@oneon/infrastructure";
import { createSnapshotRefresher } from "../middleware/active-context.js";
import { createTenantSettingsRouter } from "./tenant-settings.route.js";

const ORIGIN = "https://acme.example";
const CODE = "ABCD-EFGH-JKLM";
const NOW = Date.parse("2026-10-09T12:00:00.000Z");

/** A provider whose review and DPA are complete and whose tenant ceiling is D2: the only way a pharmacy may be raised to D2. */
const DPA = { signedOn: "2026-09-30", reference: "DPA-2026-001" };
const reviewed = (over: Partial<ProviderEntry> = {}): ProviderEntry => ({
  id: "anthropic",
  label: "Anthropic",
  limits: { personal: "D2", tenant: "D2" },
  review: "reviewed",
  tenantDpa: DPA,
  ...over,
});
const registryWith = (anthropic: ProviderEntry): Record<ProviderId, ProviderEntry> => ({ ...PROVIDER_REGISTRY, anthropic });

describe("tenant AI limit routes (spec 9.4)", () => {
  const dirs: string[] = [];
  const closers: Array<() => void> = [];
  afterEach(() => {
    for (const close of closers.splice(0).reverse()) close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const ADMIN_SNAPSHOT = { userId: "staff-admin", role: "Admin", permissions: ["settings.oneon", "jobs.read"], locationIds: [], tokenVersion: 7, tenantStatus: "Active" };
  const VIEWER_SNAPSHOT = { userId: "staff-viewer", role: "Staff", permissions: ["jobs.read"], locationIds: [], tokenVersion: 2, tenantStatus: "Active" };

  const ROUTING: ModelRouting = { standard: "deepseek", reasoning: "deepseek" };

  async function setup(
    opts: { registry?: Record<ProviderId, ProviderEntry>; configured?: ProviderId[]; overrides?: Map<ProviderId, ProviderOverride>; routing?: ModelRouting | null } = {},
  ) {
    const dir = mkdtempSync(join(tmpdir(), "tenant-settings-"));
    dirs.push(dir);
    const control = openControlDb(join(dir, "control.db"));
    closers.push(() => control.close());
    const identities = new SqliteIdentityRepository(control);
    const admin = identities.createWithLogin({ kind: "impressorx", subject: "reg:staff-admin" });
    const viewer = identities.createWithLogin({ kind: "impressorx", subject: "reg:staff-viewer" });
    const registrations = new TenantRegistrationRepository(control);
    const memberships = new MembershipRepository(control);

    const fake = new FakeImpressorx(ORIGIN, "acme", CODE);
    fake.snapshots.set("staff-admin", ADMIN_SNAPSHOT);
    fake.snapshots.set("staff-viewer", VIEWER_SNAPSHOT);
    const sent: string[] = [];
    const hooks: { onMe?: () => void } = {};
    const fetchImpl = (input: string | URL, init?: RequestInit) => {
      const path = new URL(input.toString()).pathname;
      sent.push(path);
      if (path === "/api/oneon/me") hooks.onMe?.();
      return fake.fetch(input, init);
    };
    const enrolment = new EnrolmentService({ repo: registrations, oneonOrigin: "https://oneon.example", masterKeyB64: randomBytes(32).toString("base64"), fetchImpl });
    const registration = await enrolment.enrol({ origin: ORIGIN, tenantSlug: "acme", enrolmentCode: CODE, enrolledBy: admin.id, displayName: "Acme Pharmacy" });
    const adminMembership = memberships.upsertFromHandoff({ identityId: admin.id, tenantRegistrationId: registration.id, externalUserId: "staff-admin", role: "Admin" });
    const viewerMembership = memberships.upsertFromHandoff({ identityId: viewer.id, tenantRegistrationId: registration.id, externalUserId: "staff-viewer", role: "Staff" });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const client = createImpressoRxClient({
      control,
      grantMasterKeyB64: randomBytes(32).toString("base64"),
      enrolment,
      onSnapshot: (id, snapshot) => memberships.applySnapshot(id, snapshot),
      fetchImpl,
      logger,
      sleep: async () => undefined,
    });
    // Each person opens Oneon from ImpressoRx: that is the attended grant their session is bound to.
    await client.exchangeHandoff(registration.id, await fake.mintHandoff("staff-admin"), "sess-admin", admin.id, adminMembership.id, "staff-admin");
    await client.exchangeHandoff(registration.id, await fake.mintHandoff("staff-viewer"), "sess-viewer", viewer.id, viewerMembership.id, "staff-viewer");
    sent.length = 0;

    const limits = new TenantAiLimitRepository(control, () => new Date(NOW));
    const snapshots = createSnapshotRefresher({ memberships, registrations, client, logger });

    type Who = { identityId: string; membershipId: string; sessionId: string | undefined };
    let who: Who | null = { identityId: admin.id, membershipId: adminMembership.id, sessionId: "sess-admin" };
    let personal = false;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (who) {
        req.identityId = who.identityId;
        if (who.sessionId) req.sessionId = who.sessionId;
        // What resolveActiveContext leaves for a request in a pharmacy.
        req.activeContext = personal
          ? { kind: "personal", identityId: who.identityId }
          : ({ kind: "tenant", identityId: who.identityId, membershipId: who.membershipId, registrationId: registration.id, tenantId: registration.tenantId } as ActiveContext);
      }
      next();
    });
    app.use(
      "/api/tenant",
      createTenantSettingsRouter({
        limits,
        memberships,
        snapshots,
        registry: opts.registry,
        configuredProviders: opts.configured ?? ["deepseek", "anthropic"],
        overrides: opts.overrides ?? new Map(),
        routing: opts.routing === undefined ? ROUTING : opts.routing,
        clock: () => new Date(NOW),
        logger,
      }),
    );

    const asAdmin = (sessionId: string | null = "sess-admin") => void (who = { identityId: admin.id, membershipId: adminMembership.id, sessionId: sessionId ?? undefined });
    const asViewer = () => void (who = { identityId: viewer.id, membershipId: viewerMembership.id, sessionId: "sess-viewer" });
    const inPersonal = () => void (personal = true);
    const withMissingMembership = () => void (who = { identityId: admin.id, membershipId: "ghost", sessionId: "sess-admin" });
    const grantStatuses = () => control.prepare("SELECT status, revoked_reason FROM delegation_grants ORDER BY created_at, rowid").all() as Array<{ status: string; revoked_reason: string | null }>;
    return {
      app, control, fake, sent, hooks, limits, memberships, registration, admin, viewer, adminMembership, viewerMembership, logger, asAdmin, asViewer, inPersonal, withMissingMembership, grantStatuses,
    };
  }

  type S = Awaited<ReturnType<typeof setup>>;
  const put = (s: S, maxClass: string, extra: object = {}) => request(s.app).post("/api/tenant/ai-limit").send({ maxClass, ...extra });
  /** Gives the pharmacy a starting row without going through a request. */
  const seed = (s: S, maxClass: "D0" | "D1" | "D2") =>
    s.limits.append({ registrationId: s.registration.id, maxClass, setBy: s.admin.id, liveCheckRef: "seed", evidence: null });

  describe("GET /api/tenant/ai-limit", () => {
    it("shows the default D1 and no history to anyone in the pharmacy, and who may change it from their cached snapshot", async () => {
      const s = await setup();

      const asAdmin = await request(s.app).get("/api/tenant/ai-limit");
      s.asViewer();
      const asViewer = await request(s.app).get("/api/tenant/ai-limit");

      expect(asAdmin.status).toBe(200);
      expect(TenantAiLimitViewSchema.safeParse(asAdmin.body).success).toBe(true);
      const providers = [
        { id: "deepseek", label: "DeepSeek", effective: "D1", limitedBy: null },
        { id: "anthropic", label: "Anthropic", effective: "D1", limitedBy: null },
      ];
      expect(asAdmin.body).toEqual({ current: "D1", history: [], providers, canChange: true });
      expect(asViewer.body).toEqual({ current: "D1", history: [], providers, canChange: false });
      expect(s.sent).toEqual([]); // reading never asks ImpressoRx
    });

    it("shows the pharmacy's history, newest first, to a colleague, without who set it, the live check or the evidence", async () => {
      const s = await setup();
      s.limits.append({ registrationId: s.registration.id, maxClass: "D2", setBy: s.admin.id, liveCheckRef: '{"tokenVersion":7}', evidence: { providers: [{ id: "anthropic", reference: "DPA-EVIDENCE" }] } });
      s.limits.append({ registrationId: s.registration.id, maxClass: "D0", setBy: s.viewer.id, liveCheckRef: "x", evidence: null });
      s.asViewer();

      const res = await request(s.app).get("/api/tenant/ai-limit");

      expect(res.body.current).toBe("D0");
      expect(res.body.history).toEqual([
        { id: expect.any(String), maxClass: "D0", at: "2026-10-09T12:00:00.000Z", byYou: true },
        { id: expect.any(String), maxClass: "D2", at: "2026-10-09T12:00:00.000Z", byYou: false },
      ]);
      const text = JSON.stringify(res.body);
      for (const secret of [s.admin.id, s.viewer.id, "tokenVersion", "DPA-EVIDENCE"]) expect(text).not.toContain(secret);
    });

    it("canChange follows the cached snapshot and is no authority: it is not asked of ImpressoRx", async () => {
      const s = await setup();
      s.memberships.applySnapshot(s.adminMembership.id, { role: "Staff", permissions: ["jobs.read"], locationIds: [], tenantStatus: "Active" });

      expect((await request(s.app).get("/api/tenant/ai-limit")).body.canChange).toBe(false);
      expect(s.sent).toEqual([]);
    });

    describe("the effective limit per configured provider (spec 9.4, amendment A3)", () => {
      const byId = (body: { providers: Array<{ id: string }> }) => Object.fromEntries(body.providers.map((p) => [p.id, p]));

      it("today's providers are held at D1 because they are not reviewed with a DPA, while the stored D2 stays the setting", async () => {
        const s = await setup();
        seed(s, "D2");

        const res = await request(s.app).get("/api/tenant/ai-limit");

        expect(res.body.current).toBe("D2");
        expect(res.body.providers).toEqual([
          { id: "deepseek", label: "DeepSeek", effective: "D1", limitedBy: "not_cleared" },
          { id: "anthropic", label: "Anthropic", effective: "D1", limitedBy: "not_cleared" },
        ]);
      });

      it("a provider cleared for D2 gets the pharmacy's D2 with no reason; the other is still held", async () => {
        const s = await setup({ registry: registryWith(reviewed()) });
        seed(s, "D2");

        const providers = byId((await request(s.app).get("/api/tenant/ai-limit")).body);

        expect(providers.anthropic).toEqual({ id: "anthropic", label: "Anthropic", effective: "D2", limitedBy: null });
        expect(providers.deepseek).toEqual({ id: "deepseek", label: "DeepSeek", effective: "D1", limitedBy: "not_cleared" });
      });

      it("names a platform override that lowers a provider, and a suspended provider gets no class at all", async () => {
        const overrides = new Map<ProviderId, ProviderOverride>([["anthropic", { kind: "limit", max: "D0" }], ["deepseek", { kind: "suspended" }]]);
        const s = await setup({ registry: registryWith(reviewed()), overrides });
        seed(s, "D2");

        const providers = byId((await request(s.app).get("/api/tenant/ai-limit")).body);

        expect(providers.anthropic).toMatchObject({ effective: "D0", limitedBy: "override" });
        expect(providers.deepseek).toMatchObject({ effective: null, limitedBy: "suspended" });
      });

      it("no provider is below a pharmacy limit that is lower than all of them", async () => {
        const s = await setup();
        seed(s, "D0");

        const res = await request(s.app).get("/api/tenant/ai-limit");

        expect(res.body.providers.map((p: { effective: string; limitedBy: string | null }) => [p.effective, p.limitedBy])).toEqual([["D0", null], ["D0", null]]);
      });

      it("lists configured providers only", async () => {
        const s = await setup({ configured: ["anthropic"] });
        expect((await request(s.app).get("/api/tenant/ai-limit")).body.providers.map((p: { id: string }) => p.id)).toEqual(["anthropic"]);
        const none = await setup({ configured: [] });
        expect((await request(none.app).get("/api/tenant/ai-limit")).body.providers).toEqual([]);
      });

      it("is what the gateway applies to a call to that provider in this pharmacy", async () => {
        const registry = registryWith(reviewed());
        const cases: Array<{ stored: "D0" | "D1" | "D2"; overrides: Map<ProviderId, ProviderOverride> }> = [
          { stored: "D2", overrides: new Map() },
          { stored: "D1", overrides: new Map() },
          { stored: "D0", overrides: new Map() },
          { stored: "D2", overrides: new Map<ProviderId, ProviderOverride>([["anthropic", { kind: "limit", max: "D1" }]]) },
        ];
        for (const { stored, overrides } of cases) {
          const s = await setup({ registry, overrides });
          seed(s, stored);
          const shown = byId((await request(s.app).get("/api/tenant/ai-limit")).body);
          for (const provider of ["deepseek", "anthropic"] as const) {
            const stub = { id: provider, complete: async () => ({ text: "" }) } as unknown as ModelProvider;
            const gateway = createModelGateway({
              providers: { [provider]: stub },
              registry,
              overrides,
              routing: { standard: provider, reasoning: provider },
              models: {},
              choices: { current: () => null, record: () => { throw new Error("unused"); }, history: () => [] },
              audit: { recordDecision: () => undefined, recordOutcome: () => undefined, listRecentForIdentity: () => [] },
              tenantLimit: () => s.limits.current(s.registration.id),
              fingerprinter: new Fingerprinter("k".repeat(32), 1),
              maxRetries: 0,
              timeouts: { standard: 1, reasoning: 1 },
              logger: s.logger,
            });
            const turn = gateway.beginTurn({ kind: "tenant", identityId: s.admin.id, tenantId: s.registration.tenantId, membershipId: s.adminMembership.id });
            expect(shown[provider], provider + " at " + stored).toMatchObject({ effective: turn.effectiveLimit("chat_reply") });
          }
        }
      });
    });

    it("is only for a pharmacy context", async () => {
      const s = await setup();
      s.inPersonal();
      const res = await request(s.app).get("/api/tenant/ai-limit");
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "tenant_context_required" });
    });
  });

  describe("POST /api/tenant/ai-limit", () => {
    it("an admin lowers to D0 at once: checked live, appended with the live check recorded, and reported", async () => {
      const s = await setup();

      const res = await put(s, "D0");

      expect(res.status).toBe(200);
      expect(TenantAiLimitViewSchema.safeParse(res.body).success).toBe(true);
      expect(res.body).toMatchObject({
        current: "D0",
        canChange: true,
        history: [{ maxClass: "D0", byYou: true }],
        providers: [{ id: "deepseek", effective: "D0" }, { id: "anthropic", effective: "D0" }],
      });
      expect(s.sent).toContain("/api/oneon/me"); // the live snapshot, asked now
      expect(s.limits.current(s.registration.id)).toBe("D0");
      const row = s.limits.history(s.registration.id)[0]!;
      expect(row).toMatchObject({ registrationId: s.registration.id, maxClass: "D0", setBy: s.admin.id, evidence: null });
      expect(JSON.parse(row.liveCheckRef!)).toEqual({ tokenVersion: 7, checkedAt: "2026-10-09T12:00:00.000Z" });
    });

    it("lowering again, or keeping the same class, is recorded too", async () => {
      const s = await setup();
      seed(s, "D1");

      expect((await put(s, "D1")).status).toBe(200);
      expect((await put(s, "D0")).status).toBe(200);

      expect(s.limits.history(s.registration.id).map((v) => v.maxClass)).toEqual(["D0", "D1", "D1"]);
    });

    it.each(["D3", "D4"])("%s is refused with 400 class_not_allowed, before anything is asked of ImpressoRx", async (maxClass) => {
      const s = await setup();
      const res = await put(s, maxClass);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "class_not_allowed" });
      expect(s.sent).toEqual([]);
      expect(s.limits.history(s.registration.id)).toEqual([]);
    });

    it.each([[{ maxClass: "D9" }], [{}], [{ maxClass: 1 }], [{ maxClass: "D0", registrationId: "other" }], [{ maxClass: "D0", tenantId: "other" }]])(
      "a malformed body %o is refused with 400 invalid_request and changes nothing",
      async (body) => {
        const s = await setup();
        const res = await request(s.app).post("/api/tenant/ai-limit").send(body);
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: "invalid_request" });
        expect(s.sent).toEqual([]);
        expect(s.limits.history(s.registration.id)).toEqual([]);
      },
    );

    it("the pharmacy is the session's own: a registration id in the query changes nothing about where the row goes", async () => {
      const s = await setup();
      s.control
        .prepare(
          "INSERT INTO tenant_registrations (impressorx_tenant_id, id, tenant_id, tenant_slug, display_name, origin, file_name, status, enrolled_by, enrolled_at) VALUES (lower(hex(randomblob(16))), 'other', 'other', 'other', 'Other', 'https://o', 'o.db', 'active', ?, 'now')",
        )
        .run(s.admin.id);

      expect((await request(s.app).post("/api/tenant/ai-limit?registrationId=other&tenantId=other").send({ maxClass: "D0" })).status).toBe(200);

      expect(s.limits.current(s.registration.id)).toBe("D0");
      expect(s.limits.history("other")).toEqual([]);
    });

    it("a membership that cannot be found is 403 context_unavailable, with a message a person can read", async () => {
      const s = await setup();
      s.withMissingMembership();

      const res = await put(s, "D0");

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "context_unavailable", message: expect.stringMatching(/pharmacy/i) });
      expect(s.sent).toEqual([]);
      expect(s.limits.history(s.registration.id)).toEqual([]);
    });

    it("is only for a pharmacy context", async () => {
      const s = await setup();
      s.inPersonal();
      const res = await put(s, "D0");
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "tenant_context_required" });
      expect(s.sent).toEqual([]);
    });

    describe("expectedCurrent: the class the person was looking at", () => {
      it("lets the change through while it is still the current class", async () => {
        const s = await setup();
        seed(s, "D2");

        const res = await put(s, "D1", { expectedCurrent: "D2" });

        expect(res.status).toBe(200);
        expect(s.limits.current(s.registration.id)).toBe("D1");
      });

      it("a pharmacy with no row is looked at as D1", async () => {
        const s = await setup();
        expect((await put(s, "D0", { expectedCurrent: "D1" })).status).toBe(200);
      });

      it("refuses 409 limit_changed, and appends nothing, when the class has changed since the person looked", async () => {
        const s = await setup();
        seed(s, "D0");

        const res = await put(s, "D1", { expectedCurrent: "D2" });

        expect(res.status).toBe(409);
        expect(res.body).toEqual({ error: "limit_changed" });
        expect(s.limits.history(s.registration.id)).toHaveLength(1);
      });

      it("the lost update: a lowering based on a stale D2, after another admin set D0, does not overwrite it", async () => {
        const s = await setup();
        seed(s, "D2");
        // A looked at D2 and asks for D1. While A waits for ImpressoRx, B sets D0.
        s.hooks.onMe = () => seed(s, "D0");

        const res = await put(s, "D1", { expectedCurrent: "D2" });

        expect(res.status).toBe(409);
        expect(res.body).toEqual({ error: "limit_changed" });
        expect(s.limits.current(s.registration.id)).toBe("D0");
        expect(s.limits.history(s.registration.id).map((v) => v.maxClass)).toEqual(["D0", "D2"]);
      });

      it("is optional: without it the same request is decided on the newest row alone", async () => {
        const s = await setup();
        seed(s, "D0");

        expect((await put(s, "D1")).status).toBe(200);
      });

      it.each(["D3", "D9", 1, null])("%s is not a class the page could have shown: 400 invalid_request", async (expectedCurrent) => {
        const s = await setup();
        const res = await put(s, "D0", { expectedCurrent });
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: "invalid_request" });
        expect(s.sent).toEqual([]);
      });
    });

    describe("the live check (spec 9.3 and 9.4)", () => {
      it("a person without settings.oneon is refused 403 and nothing is appended", async () => {
        const s = await setup();
        s.asViewer();

        const res = await put(s, "D0");

        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: "permission_required" });
        expect(s.limits.history(s.registration.id)).toEqual([]);
      });

      it("the live snapshot decides, not the cached one: an admin whose permission has been taken away is refused, and the membership is updated", async () => {
        const s = await setup();
        expect(s.memberships.findById(s.adminMembership.id)!.permissions).toContain("settings.oneon");
        s.fake.snapshots.set("staff-admin", { ...ADMIN_SNAPSHOT, role: "Staff", permissions: ["jobs.read"], tokenVersion: 8 });

        const res = await put(s, "D0");

        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: "permission_required" });
        expect(s.limits.history(s.registration.id)).toEqual([]);
        expect(s.memberships.findById(s.adminMembership.id)).toMatchObject({ role: "Staff", permissions: ["jobs.read"] });
      });

      it("the live snapshot decides, not the cached one: a person promoted since their last snapshot is allowed, and the membership is updated", async () => {
        const s = await setup();
        s.asViewer();
        s.fake.snapshots.set("staff-viewer", { ...VIEWER_SNAPSHOT, role: "Admin", permissions: ["settings.oneon"], tokenVersion: 3 });

        const res = await put(s, "D0");

        expect(res.status).toBe(200);
        expect(s.limits.current(s.registration.id)).toBe("D0");
        expect(JSON.parse(s.limits.history(s.registration.id)[0]!.liveCheckRef!)).toMatchObject({ tokenVersion: 3 });
        expect(s.memberships.findById(s.viewerMembership.id)).toMatchObject({ role: "Admin", permissions: ["settings.oneon"] });
      });

      it("the permission is the raw ImpressoRx code: the namespaced name does not count", async () => {
        const s = await setup();
        s.fake.snapshots.set("staff-admin", { ...ADMIN_SNAPSHOT, permissions: ["impressorx:settings.oneon", "settings.oneon.read"] });

        const res = await put(s, "D0");

        expect(res.status).toBe(403);
        expect(s.limits.history(s.registration.id)).toEqual([]);
      });

      it("ImpressoRx's own 401 suspends the membership, revokes its grants and answers 403 membership_suspended; nothing is appended", async () => {
        const s = await setup();
        for (const grant of s.fake.grants.values()) if (grant.userId === "staff-admin") grant.status = "revoked";

        const res = await put(s, "D0");

        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ error: "membership_suspended" });
        expect(s.memberships.findById(s.adminMembership.id)!.status).toBe("suspended");
        expect(s.grantStatuses().filter((g) => g.revoked_reason === "membership_suspended")).toHaveLength(1);
        expect(s.limits.history(s.registration.id)).toEqual([]);
      });

      it.each([404, 400, 302])("any other refusal (a %i) is 403 launch_required, changes the membership not at all and appends nothing", async (status) => {
        const s = await setup();
        s.fake.meStatus = status;

        const res = await put(s, "D0");

        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ error: "launch_required" });
        expect(s.memberships.findById(s.adminMembership.id)!.status).toBe("active");
        expect(s.grantStatuses().every((g) => g.status === "active")).toBe(true);
        expect(s.limits.history(s.registration.id)).toEqual([]);
      });

      it("no usable bound grant (no hand-off session, or another session's) is 403 launch_required and asks ImpressoRx nothing", async () => {
        const s = await setup();

        s.asAdmin(null);
        const none = await put(s, "D0");
        s.asAdmin("sess-viewer"); // a session bound to someone else's grant
        const other = await put(s, "D0");

        for (const res of [none, other]) {
          expect(res.status).toBe(403);
          expect(res.body).toMatchObject({ error: "launch_required" });
        }
        expect(s.sent).toEqual([]);
        expect(s.limits.history(s.registration.id)).toEqual([]);
      });

      it("an unreachable ImpressoRx is 503 impressorx_unreachable and nothing is appended, not even a lowering", async () => {
        const s = await setup();
        s.fake.unavailable = true;

        const res = await put(s, "D0");

        expect(res.status).toBe(503);
        expect(res.body).toMatchObject({ error: "impressorx_unreachable" });
        expect(s.limits.history(s.registration.id)).toEqual([]);
        expect(s.memberships.findById(s.adminMembership.id)!.status).toBe("active");
      });
    });

    describe("raising (spec 9.4)", () => {
      it("a raise to D2 is refused 409 prerequisites_missing while no provider is reviewed with a DPA, and nothing is appended", async () => {
        const s = await setup(); // the real registry: both providers are unreviewed, with no DPA
        seed(s, "D0");

        const res = await put(s, "D2");

        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ error: "prerequisites_missing" });
        expect(s.limits.history(s.registration.id)).toHaveLength(1);
        expect(s.limits.current(s.registration.id)).toBe("D0");
      });

      it("a raise to D2 is allowed when a configured provider is reviewed, holds a DPA and has a tenant ceiling that reaches D2, and records why", async () => {
        const s = await setup({ registry: registryWith(reviewed()) });
        seed(s, "D0");

        const res = await put(s, "D2");

        expect(res.status).toBe(200);
        expect(res.body.current).toBe("D2");
        expect(s.limits.history(s.registration.id)[0]).toMatchObject({
          maxClass: "D2",
          evidence: { requested: "D2", providers: [{ id: "anthropic", review: "reviewed", tenantCeiling: "D2", tenantDpa: DPA }] },
        });
      });

      it("lists every provider that justifies the raise", async () => {
        const second = { ...reviewed({ id: "deepseek", label: "DeepSeek" }), tenantDpa: { signedOn: "2026-10-01", reference: "DPA-2026-002" } };
        const registry = { anthropic: reviewed(), deepseek: second };
        const s = await setup({ registry });
        seed(s, "D0");

        await put(s, "D2");

        const evidence = s.limits.history(s.registration.id)[0]!.evidence as { providers: Array<{ id: string; tenantDpa: { reference: string } }> };
        expect(evidence.providers.map((p) => [p.id, p.tenantDpa.reference]).sort()).toEqual([["anthropic", "DPA-2026-001"], ["deepseek", "DPA-2026-002"]]);
      });

      it.each([
        ["is unreviewed", { registry: registryWith(reviewed({ review: "unreviewed" })) }],
        ["has no DPA", { registry: registryWith(reviewed({ tenantDpa: undefined })) }],
        ["has a null DPA", { registry: registryWith(reviewed({ tenantDpa: null })) }],
        ["has a tenant ceiling below the class", { registry: registryWith(reviewed({ limits: { personal: "D2", tenant: "D1" } })) }],
        ["is not configured", { registry: registryWith(reviewed()), configured: ["deepseek"] as ProviderId[] }],
        ["is suspended by the platform", { registry: registryWith(reviewed()), overrides: new Map<ProviderId, ProviderOverride>([["anthropic", { kind: "suspended" }]]) }],
        ["is capped below the class by the platform", { registry: registryWith(reviewed()), overrides: new Map<ProviderId, ProviderOverride>([["anthropic", { kind: "limit", max: "D1" }]]) }],
      ])("is refused 409 when the only reviewed provider %s", async (_name, opts) => {
        const s = await setup(opts);
        seed(s, "D0");

        const res = await put(s, "D2");

        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ error: "prerequisites_missing" });
        expect(s.limits.current(s.registration.id)).toBe("D0");
      });

      it("only reaches as high as the highest ceiling of a qualifying provider: D1 is allowed where D2 is not", async () => {
        const s = await setup({ registry: registryWith(reviewed({ limits: { personal: "D2", tenant: "D1" } })) });
        seed(s, "D0");

        expect((await put(s, "D2")).status).toBe(409);
        expect((await put(s, "D1")).status).toBe(200);
        expect(s.limits.current(s.registration.id)).toBe("D1");
      });

      it("a pharmacy with no row is at D1, so D1 is not a raise there", async () => {
        const s = await setup();
        expect((await put(s, "D1")).status).toBe(200);
      });

      describe("up to D1 a raise only has to stay within a configured provider's tenant ceiling (spec 9.4)", () => {
        it("D0 to D1 is allowed with today's providers (unreviewed, no DPA, tenant ceiling D1); the evidence names them and their ceilings only", async () => {
          const s = await setup(); // the real registry
          seed(s, "D0");

          const res = await put(s, "D1");

          expect(res.status).toBe(200);
          expect(res.body.current).toBe("D1");
          expect(s.limits.history(s.registration.id)[0]).toMatchObject({ maxClass: "D1", setBy: s.admin.id });
          expect(s.limits.history(s.registration.id)[0]!.evidence).toEqual({
            requested: "D1",
            providers: [
              { id: "deepseek", tenantCeiling: "D1", override: null },
              { id: "anthropic", tenantCeiling: "D1", override: null },
            ],
            routing: { standard: "deepseek", reasoning: "deepseek" },
          });
        });

        it("the evidence records the platform override that applied to a provider's ceiling and the routing in force, shadow included", async () => {
          const routing: ModelRouting = { standard: "anthropic", reasoning: "anthropic", shadow: "deepseek" };
          const s = await setup({
            routing,
            overrides: new Map<ProviderId, ProviderOverride>([["anthropic", { kind: "limit", max: "D1" }]]),
            registry: registryWith(reviewed()), // anthropic would reach D2 but for the override
          });
          seed(s, "D0");

          expect((await put(s, "D1")).status).toBe(200);

          expect(s.limits.history(s.registration.id)[0]!.evidence).toEqual({
            requested: "D1",
            providers: [
              { id: "deepseek", tenantCeiling: "D1", override: null },
              { id: "anthropic", tenantCeiling: "D1", override: { kind: "limit", max: "D1" } },
            ],
            routing,
          });
        });

        it("the evidence says so when there is no routing (no gateway)", async () => {
          const s = await setup({ routing: null });
          seed(s, "D0");

          await put(s, "D1");

          expect(s.limits.history(s.registration.id)[0]!.evidence).toMatchObject({ routing: null });
        });

        it("D0 to D1 rests on a configured provider only: an unconfigured one does not count", async () => {
          const s = await setup({ configured: ["deepseek"] });
          seed(s, "D0");

          expect((await put(s, "D1")).status).toBe(200);
          expect(s.limits.history(s.registration.id)[0]!.evidence).toEqual({
            requested: "D1",
            providers: [{ id: "deepseek", tenantCeiling: "D1", override: null }],
            routing: ROUTING,
          });
        });

        it.each([
          ["none is configured", { configured: [] as ProviderId[] }],
          [
            "every configured provider is capped to D0 by the platform",
            { overrides: new Map<ProviderId, ProviderOverride>([["deepseek", { kind: "limit", max: "D0" }], ["anthropic", { kind: "limit", max: "D0" }]]) },
          ],
          [
            "every configured provider is suspended by the platform",
            { overrides: new Map<ProviderId, ProviderOverride>([["deepseek", { kind: "suspended" }], ["anthropic", { kind: "suspended" }]]) },
          ],
          [
            "the only configured provider has a tenant ceiling of D0",
            { registry: { ...PROVIDER_REGISTRY, deepseek: { ...PROVIDER_REGISTRY.deepseek, limits: { personal: "D2" as const, tenant: "D0" as const } } }, configured: ["deepseek"] as ProviderId[] },
          ],
        ])("a raise to D1 is refused 409 when %s: it would go above every configured provider's ceiling", async (_name, opts) => {
          const s = await setup(opts);
          seed(s, "D0");

          const res = await put(s, "D1");

          expect(res.status).toBe(409);
          expect(res.body).toMatchObject({ error: "prerequisites_missing" });
          expect(s.limits.current(s.registration.id)).toBe("D0");
          expect(s.limits.history(s.registration.id)).toHaveLength(1);
        });

        it("a raise above every configured provider's ceiling is refused even when the provider is reviewed and holds a DPA", async () => {
          const s = await setup({ registry: registryWith(reviewed({ limits: { personal: "D2", tenant: "D1" } })) });
          seed(s, "D1");

          expect((await put(s, "D2")).status).toBe(409);
          expect(s.limits.current(s.registration.id)).toBe("D1");
        });
      });

      describe("a raise to D2 also needs the provider to be reviewed and to hold a DPA (spec 9.4)", () => {
        it("D1 to D2 is refused 409 with today's providers", async () => {
          const s = await setup();
          seed(s, "D1");

          const res = await put(s, "D2");

          expect(res.status).toBe(409);
          expect(res.body).toMatchObject({ error: "prerequisites_missing" });
          expect(s.limits.current(s.registration.id)).toBe("D1");
        });

        it("D1 to D2 is allowed with a reviewed provider that holds a DPA, and the evidence adds the review and the DPA to the ceiling", async () => {
          const s = await setup({ registry: registryWith(reviewed()) });
          seed(s, "D1");

          const res = await put(s, "D2");

          expect(res.status).toBe(200);
          expect(s.limits.history(s.registration.id)[0]!.evidence).toEqual({
            requested: "D2",
            providers: [{ id: "anthropic", tenantCeiling: "D2", override: null, review: "reviewed", tenantDpa: DPA }],
            routing: ROUTING,
          });
        });
      });

      it("lowering never needs the prerequisites, even when the provider that justified an earlier raise is no longer reviewed", async () => {
        const s = await setup({ registry: registryWith(reviewed({ review: "unreviewed" })) });
        seed(s, "D2");

        expect((await put(s, "D1")).status).toBe(200);
        expect((await put(s, "D0")).status).toBe(200);
      });

      it("is decided against the newest row at the moment of the write: another admin lowering during the live check turns a would-be lowering into a refused raise", async () => {
        const s = await setup({ configured: [] }); // no provider could justify a raise, even to D1
        seed(s, "D2");
        // The request asks for D1, which looks like a lowering from D2. While it waits for ImpressoRx, a second admin lowers to D0.
        s.hooks.onMe = () => seed(s, "D0");

        const res = await put(s, "D1");

        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ error: "prerequisites_missing" });
        expect(s.limits.current(s.registration.id)).toBe("D0");
        expect(s.limits.history(s.registration.id).map((v) => v.maxClass)).toEqual(["D0", "D2"]);
      });
    });
  });
});
