import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "@oneon/domain";
import {
  MembershipRepository,
  SqliteIdentityRepository,
  TenantRegistrationRepository,
  openControlDb,
  type MembershipSnapshot,
} from "@oneon/infrastructure";
import { createSnapshotRefresher } from "../middleware/active-context.js";
import { createContextsRouter } from "./contexts.route.js";

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const FRESH: MembershipSnapshot = { userId: "u", role: "r", permissions: [], locationIds: [], tokenVersion: 1, tenantStatus: "Active" };

type Session = { identityId: string; sessionId?: string; membershipId?: string };

describe("contexts route", () => {
  const dirs: string[] = [];
  const closers: Array<() => void> = [];
  afterEach(() => {
    for (const close of closers.splice(0)) close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // Gerry (spec 4.7): a Google login and active memberships in Acme (Admin) and Beta (WarehouseStaff); a suspended one in Gamma.
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "contexts-route-"));
    dirs.push(dir);
    const control = openControlDb(join(dir, "control.db"));
    closers.push(() => control.close());
    const identities = new SqliteIdentityRepository(control);
    const memberships = new MembershipRepository(control);
    const gerry = identities.createWithLogin({ kind: "google", subject: "gerry-sub" }).id;
    const staffOnly = identities.createWithLogin({ kind: "impressorx", subject: "acme:staff-9" }).id;
    const linked = identities.createWithLogin({ kind: "impressorx", subject: "acme:staff-8" }).id;
    // A hand-off identity that has also been linked to a Google login.
    control
      .prepare("INSERT INTO login_identities (id, identity_id, kind, subject, email, created_at) VALUES (?, ?, 'google', 'linked-sub', NULL, 'now')")
      .run(randomUUID(), linked);

    function registration(slug: string, name: string, status = "active") {
      const id = randomUUID();
      control
        .prepare(
          "INSERT INTO tenant_registrations (id, tenant_id, tenant_slug, display_name, origin, file_name, status, enrolled_by, enrolled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'now')",
        )
        .run(id, id, slug, name, `https://${slug}.example`, `${id}.db`, status, gerry);
      return id;
    }
    function membership(identityId: string, registrationId: string, externalUserId: string, role: string) {
      const m = memberships.upsertFromHandoff({ identityId, tenantRegistrationId: registrationId, externalUserId, role });
      memberships.applySnapshot(m.id, { ...FRESH, role });
      return m.id;
    }
    const acme = registration("acme", "Acme Pharmacy");
    const beta = registration("beta", "Beta Pharmacy");
    const gamma = registration("gamma", "Gamma Pharmacy");
    const delta = registration("delta", "Delta Pharmacy", "suspended_by_operator");
    const m = {
      gerryAcme: membership(gerry, acme, "gerry-acme", "Admin"),
      gerryBeta: membership(gerry, beta, "gerry-beta", "WarehouseStaff"),
      gerryGamma: membership(gerry, gamma, "gerry-gamma", "Manager"),
      gerryDelta: membership(gerry, delta, "gerry-delta", "Manager"),
      staffAcme: membership(staffOnly, acme, "staff-9", "Manager"),
      staffBeta: membership(staffOnly, beta, "staff-9b", "Manager"),
      linkedAcme: membership(linked, acme, "staff-8", "Pharmacist"),
    };
    memberships.setStatus(m.gerryGamma, "suspended");

    let session: Session = { identityId: gerry };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.identityId = session.identityId;
      req.userId = session.identityId;
      if (session.sessionId) req.sessionId = session.sessionId;
      if (session.membershipId) req.sessionContext = { kind: "tenant", membershipId: session.membershipId };
      next();
    });
    app.use(
      "/api/contexts",
      createContextsRouter({
        memberships,
        registrations: new TenantRegistrationRepository(control),
        identities,
        snapshots: createSnapshotRefresher({ memberships, registrations: new TenantRegistrationRepository(control), client: null, logger }),
        logger,
      }),
    );
    return { app, control, memberships, m, gerry, staffOnly, linked, actAs: (next: Session) => (session = next) };
  }

  const acmeOption = (membershipId: string, role: string) => ({ kind: "tenant", membershipId, tenantName: "Acme Pharmacy", role });

  describe("GET /api/contexts", () => {
    it("lists only active memberships, with the pharmacy name and role, and personal for a Google login", async () => {
      const f = setup();

      const res = await request(f.app).get("/api/contexts");

      expect(res.status).toBe(200);
      expect(res.body.active).toEqual({ kind: "personal" });
      expect(res.body.available).toEqual([
        { kind: "personal" },
        acmeOption(f.m.gerryAcme, "Admin"),
        { kind: "tenant", membershipId: f.m.gerryBeta, tenantName: "Beta Pharmacy", role: "WarehouseStaff" },
      ]); // not Gamma (membership suspended), not Delta (the operator suspended the pharmacy)
    });

    it("omits personal for a tenant-only identity", async () => {
      const f = setup();
      f.actAs({ identityId: f.staffOnly, sessionId: "s1", membershipId: f.m.staffAcme });

      const res = await request(f.app).get("/api/contexts");

      expect(res.body.available).toEqual([acmeOption(f.m.staffAcme, "Manager")]);
      expect(res.body.available).not.toContainEqual({ kind: "personal" });
    });

    it("a hand-off session lists only the membership its grant is bound to", async () => {
      const f = setup();
      f.actAs({ identityId: f.staffOnly, sessionId: "s1", membershipId: f.m.staffAcme });

      const res = await request(f.app).get("/api/contexts");

      expect(res.body.active).toEqual(acmeOption(f.m.staffAcme, "Manager"));
      expect(res.body.available).toEqual([acmeOption(f.m.staffAcme, "Manager")]); // staffBeta is active too, but switching would 401
    });

    it("a hand-off session does not offer personal even when the identity has a Google login", async () => {
      const f = setup();
      f.actAs({ identityId: f.linked, sessionId: "s1", membershipId: f.m.linkedAcme });

      const res = await request(f.app).get("/api/contexts");

      expect(res.body.available).toEqual([acmeOption(f.m.linkedAcme, "Pharmacist")]);
    });

    it("a Google session in a tenant context reports it as active and still offers personal", async () => {
      const f = setup();
      f.actAs({ identityId: f.gerry, membershipId: f.m.gerryBeta });

      const res = await request(f.app).get("/api/contexts");

      expect(res.body.active).toEqual({ kind: "tenant", membershipId: f.m.gerryBeta, tenantName: "Beta Pharmacy", role: "WarehouseStaff" });
      expect(res.body.available).toContainEqual({ kind: "personal" });
    });

    it("still reports a suspended membership as active (so the person can leave it) but never offers it", async () => {
      const f = setup();
      f.actAs({ identityId: f.gerry, membershipId: f.m.gerryGamma });

      const res = await request(f.app).get("/api/contexts");

      expect(res.body.active).toMatchObject({ kind: "tenant", membershipId: f.m.gerryGamma, tenantName: "Gamma Pharmacy" });
      expect(res.body.available).not.toContainEqual(expect.objectContaining({ membershipId: f.m.gerryGamma }));
      expect(res.body.available).toContainEqual({ kind: "personal" });
    });

    it("falls back to personal when the session names a membership that is not the identity's", async () => {
      const f = setup();
      f.actAs({ identityId: f.gerry, membershipId: f.m.staffAcme });

      const res = await request(f.app).get("/api/contexts");

      expect(res.body.active).toEqual({ kind: "personal" });
    });
  });

  describe("POST /api/contexts/validate", () => {
    const validate = (f: ReturnType<typeof setup>, body: unknown) => request(f.app).post("/api/contexts/validate").send(body as object);

    it("allows personal for an identity with a Google login and refuses it for a tenant-only identity", async () => {
      const f = setup();
      expect((await validate(f, { kind: "personal" })).status).toBe(200);

      f.actAs({ identityId: f.staffOnly });
      const res = await validate(f, { kind: "personal" });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("context_unavailable");
    });

    it("allows the identity's own active membership", async () => {
      const f = setup();
      expect((await validate(f, { kind: "tenant", membershipId: f.m.gerryBeta })).status).toBe(200);
    });

    it.each([
      ["another identity's membership", (m: ReturnType<typeof setup>["m"]) => m.staffAcme],
      ["a suspended membership", (m: ReturnType<typeof setup>["m"]) => m.gerryGamma],
      ["a membership at a pharmacy the operator suspended", (m: ReturnType<typeof setup>["m"]) => m.gerryDelta],
      ["an unknown membership", () => "no-such-membership"],
    ])("refuses %s", async (_name, pick) => {
      const f = setup();
      const res = await validate(f, { kind: "tenant", membershipId: pick(f.m) });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("context_unavailable");
    });

    it("a hand-off session may name only the membership its grant is bound to", async () => {
      const f = setup();
      f.actAs({ identityId: f.staffOnly, sessionId: "s1", membershipId: f.m.staffAcme });

      expect((await validate(f, { kind: "tenant", membershipId: f.m.staffAcme })).status).toBe(200);
      expect((await validate(f, { kind: "tenant", membershipId: f.m.staffBeta })).status).toBe(403);
      f.actAs({ identityId: f.linked, sessionId: "s2", membershipId: f.m.linkedAcme });
      expect((await validate(f, { kind: "personal" })).status).toBe(403);
    });

    it("refuses a malformed body", async () => {
      const f = setup();
      for (const body of [{}, { kind: "other" }, { kind: "tenant" }, { kind: "tenant", membershipId: 7 }, "personal"]) {
        expect((await validate(f, body)).status).toBe(400);
      }
    });

    it("a stale snapshot without a usable grant is launch_required, so the person does not land in a broken context", async () => {
      const f = setup();
      f.control.prepare("UPDATE memberships SET snapshot_at = ? WHERE id = ?").run(new Date(0).toISOString(), f.m.gerryBeta);

      const res = await validate(f, { kind: "tenant", membershipId: f.m.gerryBeta });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "launch_required", message: expect.stringMatching(/ImpressoRx/) });
      expect(f.memberships.findById(f.m.gerryBeta)!.status).toBe("active");
    });
  });
});
