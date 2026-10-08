import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ContextDbGate,
  ensureIdentityAnchor,
  MembershipRepository,
  SqliteIdentityRepository,
  openControlDb,
  rawDb,
} from "@oneon/infrastructure";
import type { ContextDb, Logger } from "@oneon/domain";
import { resolveActiveContext } from "../middleware/active-context.js";
import { contextRepos } from "../context-wiring.js";
import { createChatRouter } from "../routes/chat.route.js";
import { loadEnv } from "../config/env.js";
import { createContainer } from "../container.js";
import { registerRoutes } from "../routes/index.js";

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

// Spec 4.7 fixture: Gerry has a Google login, a membership in tenant A (Admin) and one in tenant B (WarehouseStaff).
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tenant-isolation-"));
  const control = openControlDb(join(dir, "control.db"));
  const gate = new ContextDbGate({ control, personalPath: join(dir, "personal.db"), tenantDir: join(dir, "tenants") });
  const identities = new SqliteIdentityRepository(control);
  const memberships = new MembershipRepository(control);
  const gerry = identities.createWithLogin({ kind: "google", subject: "gerry-sub" }).id;
  const staffOnly = identities.createWithLogin({ kind: "impressorx", subject: "reg-a:staff" }).id;
  const personal = gate.openPersonal();
  rawDb(personal).prepare("INSERT INTO users (id, email) VALUES (?, ?)").run(gerry, "gerry@example.com");

  function tenant(slug: string, identityId: string, role: string) {
    const registrationId = randomUUID();
    const tenantId = randomUUID();
    control
      .prepare(
        "INSERT INTO tenant_registrations (id, tenant_id, tenant_slug, display_name, origin, file_name, status, enrolled_by, enrolled_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, 'now')",
      )
      .run(registrationId, tenantId, slug, slug, `https://${slug}.example`, `${registrationId}.db`, gerry);
    gate.createTenantFile(registrationId, tenantId);
    const membership = memberships.upsertFromHandoff({ identityId, tenantRegistrationId: registrationId, externalUserId: `${slug}-staff`, role });
    return { registrationId, tenantId, membershipId: membership.id };
  }
  const a = tenant("a", gerry, "Admin");
  const b = tenant("b", gerry, "WarehouseStaff");

  // The session the request carries: a hand-off session names a membership; a Google session names nothing.
  let session: { identityId: string; membershipId?: string } = { identityId: gerry };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.identityId = session.identityId;
    req.userId = session.identityId;
    if (session.membershipId) {
      req.sessionId = "s1";
      req.sessionContext = { kind: "tenant", membershipId: session.membershipId };
    }
    next();
  });
  app.use(
    "/api/chat",
    resolveActiveContext({ gate, memberships, identities }),
    createChatRouter({ conversationsFor: (req) => contextRepos(req.contextDb!).conversations, logger }),
  );

  return {
    app, gate, control, memberships, gerry, staffOnly, a, b, personal,
    actAs: (next: typeof session) => (session = next),
    close: () => {
      gate.close();
      control.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("tenant isolation through the active context", () => {
  const open: Array<() => void> = [];
  afterEach(() => {
    for (const close of open.splice(0)) close();
  });
  const setup = () => {
    const f = fixture();
    open.push(f.close);
    return f;
  };
  const say = (f: ReturnType<typeof fixture>, text: string) =>
    request(f.app).post("/api/chat").send({ message: text, conversationId: "shared-id" });
  const countIn = (db: ContextDb) => contextRepos(db).conversations.countByConversation("shared-id");

  it("a conversation started in tenant A is invisible in B and in personal", async () => {
    const f = setup();
    f.actAs({ identityId: f.gerry, membershipId: f.a.membershipId });
    expect((await say(f, "stock in A")).status).toBe(200);

    expect(countIn(f.gate.openTenant(f.a.registrationId))).toBeGreaterThan(0);
    expect(countIn(f.gate.openTenant(f.b.registrationId))).toBe(0);
    expect(countIn(f.personal)).toBe(0);
    const rows = rawDb(f.gate.openTenant(f.a.registrationId)).prepare("SELECT DISTINCT tenant_id FROM conversations").all();
    expect(rows).toEqual([{ tenant_id: f.a.tenantId }]);
  });

  it("a conversation started in personal is invisible in A and B", async () => {
    const f = setup();
    f.actAs({ identityId: f.gerry });
    expect((await say(f, "my own note")).status).toBe(200);

    expect(countIn(f.personal)).toBeGreaterThan(0);
    expect(countIn(f.gate.openTenant(f.a.registrationId))).toBe(0);
    expect(countIn(f.gate.openTenant(f.b.registrationId))).toBe(0);
    expect(rawDb(f.personal).prepare("SELECT DISTINCT tenant_id FROM conversations").all()).toEqual([{ tenant_id: null }]);
  });

  it("a row with another tenant's id in A's file throws tenant_mismatch on read", () => {
    const f = setup();
    const dbA = f.gate.openTenant(f.a.registrationId);
    rawDb(dbA)
      .prepare("INSERT INTO conversations (id, conversation_id, role, content, user_id, tenant_id) VALUES ('x', 'shared-id', 'user', 'planted', NULL, ?)")
      .run(f.b.tenantId);

    expect(() => contextRepos(dbA).conversations.findRecentByConversation("shared-id", 10)).toThrow("tenant_mismatch");
  });

  it("an unstamped row in A's file and a tenant row in the personal file are refused the same way", () => {
    const f = setup();
    const dbA = f.gate.openTenant(f.a.registrationId);
    rawDb(dbA).prepare("INSERT INTO conversations (id, conversation_id, role, content) VALUES ('x', 'shared-id', 'user', 'unstamped')").run();
    rawDb(f.personal)
      .prepare("INSERT INTO conversations (id, conversation_id, role, content, tenant_id) VALUES ('y', 'shared-id', 'user', 'planted', ?)")
      .run(f.a.tenantId);

    expect(() => contextRepos(dbA).conversations.findRecentByConversation("shared-id", 10)).toThrow("tenant_mismatch");
    expect(() => contextRepos(f.personal).conversations.findRecentByConversation("shared-id", 10)).toThrow("tenant_mismatch");
  });

  it("action instances and events are stamped with the handle tenant and refuse a foreign row", () => {
    const f = setup();
    const dbA = f.gate.openTenant(f.a.registrationId);
    ensureIdentityAnchor(dbA, f.gerry);
    const repo = contextRepos(dbA).actionInstances;
    repo.create(
      {
        id: "act-1", scope: "tenant", ownerId: f.a.tenantId, userId: f.gerry, tenantId: f.a.tenantId, locationIds: [],
        actionType: "notify", definitionVersion: "1", initiator: "user", initiatorUserId: f.gerry, input: {}, evidence: [],
        idempotencyKey: "k1", retryOf: null, attemptNumber: 1, resourceRef: null,
      },
      { kind: "user", userId: f.gerry },
    );
    expect(rawDb(dbA).prepare("SELECT tenant_id FROM action_instances").all()).toEqual([{ tenant_id: f.a.tenantId }]);
    expect(rawDb(dbA).prepare("SELECT tenant_id FROM action_events").all()).toEqual([{ tenant_id: f.a.tenantId }]);

    rawDb(dbA).pragma("ignore_check_constraints = ON");
    rawDb(dbA).prepare("UPDATE action_instances SET tenant_id = ?").run(f.b.tenantId);
    rawDb(dbA).pragma("ignore_check_constraints = OFF");
    expect(() => repo.findById(f.a.tenantId, "act-1")).toThrow("tenant_mismatch");
  });

  it("memoizes the repositories per handle", () => {
    const f = setup();
    const dbA = f.gate.openTenant(f.a.registrationId);
    expect(contextRepos(dbA)).toBe(contextRepos(dbA));
    expect(contextRepos(dbA)).not.toBe(contextRepos(f.personal));
  });

  it("a request naming a suspended membership gets 403 context_unavailable", async () => {
    const f = setup();
    f.memberships.setStatus(f.a.membershipId, "suspended");
    f.actAs({ identityId: f.gerry, membershipId: f.a.membershipId });

    const res = await say(f, "hello");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "context_unavailable" });
    expect(countIn(f.gate.openTenant(f.a.registrationId))).toBe(0);
  });

  it("a membership of another identity gets 403, and a tenant the registry suspended gets 403", async () => {
    const f = setup();
    f.actAs({ identityId: f.staffOnly, membershipId: f.a.membershipId });
    expect((await say(f, "hello")).status).toBe(403);

    f.actAs({ identityId: f.gerry, membershipId: f.b.membershipId });
    f.control.prepare("UPDATE tenant_registrations SET status = 'suspended_by_operator' WHERE id = ?").run(f.b.registrationId);
    const res = await say(f, "hello");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "context_unavailable" });
  });

  it("a tenant-only identity cannot select personal", async () => {
    const f = setup();
    f.actAs({ identityId: f.staffOnly });

    const res = await say(f, "hello");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "context_unavailable" });
  });

  it("a request cannot name its context in the body or query", async () => {
    const f = setup();
    f.actAs({ identityId: f.gerry });
    const res = await request(f.app)
      .post("/api/chat")
      .query({ tenantId: f.a.tenantId, registrationId: f.a.registrationId })
      .send({ message: "hi", conversationId: "shared-id", tenantId: f.a.tenantId, registrationId: f.a.registrationId });

    expect(res.status).toBe(200);
    expect(countIn(f.personal)).toBeGreaterThan(0);
    expect(countIn(f.gate.openTenant(f.a.registrationId))).toBe(0);
  });
});

describe("personal routes refuse a tenant session", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function build(asTenant: boolean) {
    vi.stubEnv("NEXTAUTH_SECRET", "test-secret");
    vi.stubEnv("ALLOWED_EMAILS", "alice@test.com");
    vi.stubEnv("API_TOKEN", "test-api-token");
    vi.stubEnv("OAUTH_TOKEN_ENCRYPTION_KEY", "test-encryption-key-at-least-32-chars");
    vi.stubEnv("GOOGLE_CLIENT_ID", "test-client-id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-client-secret");
    vi.stubEnv("GOOGLE_REFRESH_TOKEN", "");
    vi.stubEnv("DATABASE_PATH", ":memory:");
    vi.stubEnv("CONTROL_DATABASE_PATH", ":memory:");
    vi.stubEnv("LOG_LEVEL", "error");
    vi.stubEnv("FEATURE_CHAT", "true");
    vi.stubEnv("FEATURE_PERSONAL_MEMORY", "true");
    vi.stubEnv("FEATURE_FINANCE_STATEMENT_INTAKE", "true");
    const container = createContainer(loadEnv());
    const app = express();
    app.use(express.json());
    // Stands in for session auth, which has already accepted the session by the time the route chain runs.
    app.use((req, _res, next) => {
      req.identityId = "an-identity";
      req.userId = "an-identity";
      if (asTenant) {
        req.sessionId = "s1";
        req.sessionContext = { kind: "tenant", membershipId: "m1" };
      }
      next();
    });
    registerRoutes(app, container);
    return { app, container };
  }

  const PERSONAL_GETS = [
    "/api/inbox",
    "/api/today",
    "/api/deadlines",
    "/api/notifications",
    "/api/notification-preferences",
    "/api/profile",
    "/api/memory/notes",
    "/api/finance/statements",
    "/api/integrations",
    "/api/actions",
    "/api/action-definitions",
    "/api/ai-data",
    "/api/cycle",
    "/api/status",
    "/api/oauth/google/start",
    "/api/platform/enrolments",
  ];

  it.each(PERSONAL_GETS)("GET %s gets 403 context_unavailable for a tenant session", async (path) => {
    const { app, container } = build(true);
    try {
      const res = await request(app).get(path);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "context_unavailable" });
    } finally {
      container.shutdown();
    }
  });

  it("the same routes still answer a Google session", async () => {
    const { app, container } = build(false);
    try {
      for (const path of ["/api/notifications", "/api/profile", "/api/inbox"]) {
        const res = await request(app).get(path);
        expect(res.status, path).not.toBe(403);
      }
    } finally {
      container.shutdown();
    }
  });
});
