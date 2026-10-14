import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ContextDbGate,
  ensureIdentityAnchor,
  SqliteActionConfigRepository,
  SqliteLegacyActionRepository,
  MembershipRepository,
  SqliteIdentityRepository,
  TenantRegistrationRepository,
  openControlDb,
  rawDb,
} from "@oneon/infrastructure";
import type { ContextDb, Logger } from "@oneon/domain";
import { createSnapshotRefresher, resolveActiveContext } from "../middleware/active-context.js";
import { contextRepos } from "../context-wiring.js";
import { createChatRouter, type ChatRouteDeps } from "../routes/chat.route.js";
import { createActionRegistry, createListPendingActionsTool, createShowMyAccessTool, createToolRegistry, type ModelGateway } from "@oneon/application";
import { loadEnv } from "../config/env.js";
import { createContainer } from "../container.js";
import { registerRoutes } from "../routes/index.js";

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

// Spec 4.7 fixture: Gerry has a Google login, a membership in tenant A (Admin) and one in tenant B (WarehouseStaff).
function fixture(chat?: (parts: { memberships: MembershipRepository }) => Partial<ChatRouteDeps>) {
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
    // A fresh snapshot, as a hand-off leaves it; a stale one would need ImpressoRx (see active-context.test.ts).
    memberships.applySnapshot(membership.id, { role, permissions: [], locationIds: [], tenantStatus: "Active" });
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
    resolveActiveContext({ gate, memberships, identities, snapshots: createSnapshotRefresher({ memberships, registrations: new TenantRegistrationRepository(control), client: null, logger }), logger }),
    createChatRouter({ conversationsFor: (req) => contextRepos(req.contextDb!).conversations, logger, ...chat?.({ memberships }) }),
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

    expect(countIn(f.gate.lease(f.a.registrationId).db)).toBeGreaterThan(0);
    expect(countIn(f.gate.lease(f.b.registrationId).db)).toBe(0);
    expect(countIn(f.personal)).toBe(0);
    const rows = rawDb(f.gate.lease(f.a.registrationId).db).prepare("SELECT DISTINCT tenant_id FROM conversations").all();
    expect(rows).toEqual([{ tenant_id: f.a.tenantId }]);
  });


  describe("tenant chat with a model", () => {
    const tenantTools = (memberships: MembershipRepository) => {
      const registry = createToolRegistry();
      const personalTool = vi.fn(() => ({ data: [], summary: "personal" }));
      registry.register({
        name: "list_inbox", version: "1", description: "personal inbox", contexts: ["personal"],
        inputSchema: z.object({}).passthrough(), output: { fields: {}, summaryClass: "D1" }, execute: personalTool,
      });
      registry.register(createShowMyAccessTool({ memberships }));
      registry.register(createListPendingActionsTool({ instanceRepo: {} as never, registry: createActionRegistry([]) }));
      return { registry, personalTool };
    };
    // Asks for one tool, then stops; the chat reply is denied so the tool summaries answer.
    const asking = (tool: string): { gateway: ModelGateway; contexts: unknown[] } => {
      const contexts: unknown[] = [];
      const gateway: ModelGateway = {
        beginTurn: (context) => {
          contexts.push(context);
          let round = 0; // per turn: the first intent round asks for the tool, the next stops
          return {
            call: async (req) =>
              req.purpose === "chat_reply"
                ? { kind: "denied", reason: "required_part_withheld", withheld: [], decisionId: "d", callId: "c" }
                : { kind: "answered", text: "", json: round++ === 0 ? [{ tool, parameters: {} }] : [{ tool: "none", parameters: {} }], withheld: [], decisionId: "d", callId: "c" },
            restoreToolParams: (params) => ({ ok: true, params }),
            effectiveLimit: () => "D1",
          };
        },
      };
      return { gateway, contexts };
    };
    const withModel = (tool: string) => {
      const asked = asking(tool);
      let personalTool: ReturnType<typeof tenantTools>["personalTool"] | undefined;
      const f = fixture(({ memberships }) => {
        const tools = tenantTools(memberships);
        personalTool = tools.personalTool;
        return {
          toolRegistry: tools.registry,
          modelGatewayFor: () => asked.gateway,
          tenantActionsFor: (req) => ({ instanceRepo: contextRepos(req.contextDb!).actionInstances, registry: createActionRegistry([]) }),
        };
      });
      open.push(f.close);
      return { f, contexts: asked.contexts, personalTool: () => personalTool! };
    };

    it("shows the access of the membership the session names: A's role in A, B's role in B", async () => {
      const { f, contexts } = withModel("show_my_access");

      f.actAs({ identityId: f.gerry, membershipId: f.a.membershipId });
      expect((await say(f, "what is my role?")).body.response).toContain("Role Admin");
      f.actAs({ identityId: f.gerry, membershipId: f.b.membershipId });
      expect((await say(f, "what is my role?")).body.response).toContain("Role WarehouseStaff");

      expect(contexts).toEqual([
        { kind: "tenant", identityId: f.gerry, tenantId: f.a.tenantId, membershipId: f.a.membershipId },
        { kind: "tenant", identityId: f.gerry, tenantId: f.b.tenantId, membershipId: f.b.membershipId },
      ]);
    });

    it("reads the tenant file's own pending actions, never the personal ones", async () => {
      const { f } = withModel("list_pending_actions");
      f.actAs({ identityId: f.gerry, membershipId: f.a.membershipId });

      const res = await say(f, "what is waiting?");

      expect(res.status).toBe(200);
      expect(res.body.response).toContain("Found 0 actions awaiting approval.");
    });

    it("does not run a personal tool in a tenant context, and offers personal tools in personal", async () => {
      const { f, personalTool, contexts } = withModel("list_inbox");

      f.actAs({ identityId: f.gerry, membershipId: f.a.membershipId });
      await say(f, "read my mail");
      expect(personalTool()).not.toHaveBeenCalled();

      f.actAs({ identityId: f.gerry });
      await say(f, "read my mail");
      expect(personalTool()).toHaveBeenCalledTimes(1);
      expect(contexts[1]).toEqual({ kind: "personal", identityId: f.gerry });
    });
  });

  it("a conversation started in personal is invisible in A and B", async () => {
    const f = setup();
    f.actAs({ identityId: f.gerry });
    expect((await say(f, "my own note")).status).toBe(200);

    expect(countIn(f.personal)).toBeGreaterThan(0);
    expect(countIn(f.gate.lease(f.a.registrationId).db)).toBe(0);
    expect(countIn(f.gate.lease(f.b.registrationId).db)).toBe(0);
    expect(rawDb(f.personal).prepare("SELECT DISTINCT tenant_id FROM conversations").all()).toEqual([{ tenant_id: null }]);
  });

  it("a row with another tenant's id in A's file throws tenant_mismatch on read", () => {
    const f = setup();
    const dbA = f.gate.lease(f.a.registrationId).db;
    rawDb(dbA)
      .prepare("INSERT INTO conversations (id, conversation_id, role, content, user_id, tenant_id) VALUES ('x', 'shared-id', 'user', 'planted', NULL, ?)")
      .run(f.b.tenantId);

    expect(() => contextRepos(dbA).conversations.findRecentByConversation("shared-id", 10)).toThrow("tenant_mismatch");
  });

  it("an unstamped row in A's file and a tenant row in the personal file are refused the same way", () => {
    const f = setup();
    const dbA = f.gate.lease(f.a.registrationId).db;
    rawDb(dbA).prepare("INSERT INTO conversations (id, conversation_id, role, content) VALUES ('x', 'shared-id', 'user', 'unstamped')").run();
    rawDb(f.personal)
      .prepare("INSERT INTO conversations (id, conversation_id, role, content, tenant_id) VALUES ('y', 'shared-id', 'user', 'planted', ?)")
      .run(f.a.tenantId);

    expect(() => contextRepos(dbA).conversations.findRecentByConversation("shared-id", 10)).toThrow("tenant_mismatch");
    expect(() => contextRepos(f.personal).conversations.findRecentByConversation("shared-id", 10)).toThrow("tenant_mismatch");
  });

  it("action instances and events are stamped with the handle tenant and refuse a foreign row", () => {
    const f = setup();
    const dbA = f.gate.lease(f.a.registrationId).db;
    ensureIdentityAnchor(dbA, f.gerry);
    const repo = contextRepos(dbA).actionInstances;
    repo.create(
      {
        id: "act-1", scope: "tenant", ownerId: f.a.tenantId, userId: f.gerry, tenantId: f.a.tenantId, locationIds: [],
        actionType: "notify", definitionVersion: "1", initiator: "user", initiatorUserId: f.gerry, input: {}, evidence: [],
        idempotencyKey: "k1", retryOf: null, attemptNumber: 1, resourceRef: null, modelCallId: null,
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

  it("a tenant_mismatch inside a request is logged at error level with the code, tenant and source, then answers 500", async () => {
    const f = setup();
    const dbA = f.gate.lease(f.a.registrationId).db;
    ensureIdentityAnchor(dbA, f.gerry);
    rawDb(dbA)
      .prepare("INSERT INTO conversations (id, conversation_id, role, content, user_id, tenant_id) VALUES ('x', 'shared-id', 'user', 'SECRET-CONTENT', ?, ?)")
      .run(f.gerry, f.b.tenantId);
    f.actAs({ identityId: f.gerry, membershipId: f.a.membershipId });
    vi.mocked(logger.error).mockClear();

    const res = await say(f, "hello");

    expect(res.status).toBe(500);
    const call = vi.mocked(logger.error).mock.calls.find(([, meta]) => (meta as { code?: string } | undefined)?.code === "tenant_mismatch");
    expect(call?.[1]).toMatchObject({ code: "tenant_mismatch", tenantId: f.a.tenantId, source: "conversations" });
    expect(JSON.stringify(call)).not.toContain("SECRET-CONTENT");
  });

  it("action configs: a tenant file holds only its own tenant scope, the personal file only personal", () => {
    const f = setup();
    const dbA = f.gate.lease(f.a.registrationId).db;
    const inA = new SqliteActionConfigRepository(dbA);
    const inPersonal = new SqliteActionConfigRepository(f.personal);
    const save = (scope: "personal" | "tenant", ownerId: string) => ({ scope, ownerId, actionType: "notify", configJson: "{}", changedBy: f.gerry });

    expect(inA.save(save("tenant", f.a.tenantId)).ownerId).toBe(f.a.tenantId);
    expect(() => inA.save(save("personal", f.gerry))).toThrow("tenant_mismatch");
    expect(() => inA.save(save("tenant", f.b.tenantId))).toThrow("tenant_mismatch");
    expect(() => inA.get("tenant", f.b.tenantId, "notify")).toThrow("tenant_mismatch");
    expect(() => inA.list("personal", f.gerry)).toThrow("tenant_mismatch");
    expect(() => inA.history("tenant", f.b.tenantId, "notify", 5)).toThrow("tenant_mismatch");

    expect(inPersonal.save(save("personal", f.gerry)).scope).toBe("personal");
    expect(() => inPersonal.save(save("tenant", f.a.tenantId))).toThrow("tenant_mismatch");
    expect(() => inPersonal.get("tenant", f.a.tenantId, "notify")).toThrow("tenant_mismatch");
    expect(() => inPersonal.list("tenant", f.a.tenantId)).toThrow("tenant_mismatch");
  });

  it("legacy actions are personal-only", () => {
    const f = setup();
    expect(() => new SqliteLegacyActionRepository(f.gate.lease(f.a.registrationId).db)).toThrow();
    expect(() => new SqliteLegacyActionRepository(f.personal)).not.toThrow();
  });

  it("model audit refuses a decision whose tenant differs from the handle", () => {
    const f = setup();
    const decision = (tenantId: string | null) =>
      ({
        id: randomUUID(), callId: randomUUID(), createdAt: "2026-10-08T10:00:00Z", contextKind: tenantId ? "tenant" : "personal",
        identityId: f.gerry, tenantId, membershipId: null, purpose: "chat", channel: null, provider: "anthropic", model: null,
        effectiveLimit: null, layers: [], decision: "deny", denyReason: null, released: [], withheld: [], placeholderCount: 0,
        scannerHits: { D3: 0, D4: 0 }, alert: false, policyFingerprint: "p", inputFingerprint: null, keyVersion: 1,
      }) as never;
    const inA = contextRepos(f.gate.lease(f.a.registrationId).db).modelAudit;
    const inPersonal = contextRepos(f.personal).modelAudit;

    expect(() => inA.recordDecision(decision(f.b.tenantId))).toThrow("tenant_mismatch");
    expect(() => inA.recordDecision(decision(null))).toThrow("tenant_mismatch");
    expect(() => inPersonal.recordDecision(decision(f.a.tenantId))).toThrow("tenant_mismatch");
    expect(() => inPersonal.recordDecision(decision(null))).not.toThrow();
  });

  it("memoizes the repositories per handle", () => {
    const f = setup();
    const dbA = f.gate.lease(f.a.registrationId).db;
    expect(contextRepos(dbA) === contextRepos(dbA)).toBe(true);
    expect(contextRepos(dbA) === contextRepos(f.personal)).toBe(false);
  });

  it("a request naming a suspended membership gets 403 with the suspended message", async () => {
    const f = setup();
    f.memberships.setStatus(f.a.membershipId, "suspended");
    f.actAs({ identityId: f.gerry, membershipId: f.a.membershipId });

    const res = await say(f, "hello");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "membership_suspended", message: "This pharmacy has switched Oneon off, or your account is inactive." });
    expect(countIn(f.gate.lease(f.a.registrationId).db)).toBe(0);
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
    expect(countIn(f.gate.lease(f.a.registrationId).db)).toBe(0);
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

  // The context-aware routes resolve the session's membership (the test's "m1" does not exist, so they cannot open it);
  // every other route is personal-only and says so.
  const CONTEXT_AWARE = ["/api/actions", "/api/action-definitions"];

  it.each(PERSONAL_GETS)("GET %s gets 403 for a tenant session", async (path) => {
    const { app, container } = build(true);
    try {
      const res = await request(app).get(path);
      expect(res.status).toBe(403);
      // The test's tenant session is a hand-off session, which never gets the personal context.
      expect(res.body).toEqual(
        CONTEXT_AWARE.includes(path)
          ? { error: "context_unavailable" }
          : { error: "personal_context_required", message: "Personal isn't available when you open Oneon from a pharmacy. Sign in with Google to use it." },
      );
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

  it("the identity link routes are not personal-only (a hand-off session starts a link), and the link itself takes the service token", async () => {
    const { app, container } = build(true);
    try {
      container.identityRepo.createWithLogin({ kind: "impressorx", subject: "reg:user", id: "an-identity" });

      const intent = await request(app).post("/api/identity/link-intent").send({});
      expect(intent.status).toBe(200);
      expect(intent.body).toMatchObject({ next: "google" });

      const login = { kind: "google", subject: "s", email: "a@b.com" };
      const noToken = await request(app).post("/api/identity/link").send({ linkIntentId: "x", secret: "y", login });
      expect(noToken.status).toBe(401);
      // A session alone is not enough for the link call, and the token alone is not a session for the others.
      const withToken = await request(app).post("/api/identity/link").set("Authorization", "Bearer test-api-token").send({ linkIntentId: "x", secret: "y", login });
      expect(withToken.status).toBe(409);
      expect(withToken.body).toEqual({ error: "link_expired" });
    } finally {
      container.shutdown();
    }
  });
});
