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
  MembershipRepository,
  SqliteAiDataChoiceRepository,
  SqliteIdentityRepository,
  TenantRegistrationRepository,
  openControlDb,
  rawDb,
} from "@oneon/infrastructure";
import type { ContextDb, Logger } from "@oneon/domain";
import {
  Fingerprinter,
  createChatActionTools,
  createModelGateway,
  createToolRegistry,
  type AnyActionDefinition,
  type ApprovedModelCall,
  type ModelGateway,
  type ModelProvider,
  type ProviderCompletion,
} from "@oneon/application";
import { createSnapshotRefresher, resolveActiveContext } from "../middleware/active-context.js";
import { activeMembershipLookup, actorForContext, contextRepos } from "../context-wiring.js";
import { createActionsFor } from "../actions-wiring.js";
import { createChatRouter } from "../routes/chat.route.js";

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

/** Answers each call from a script, in order. */
class ScriptedProvider implements ModelProvider {
  readonly id = "deepseek" as const;
  constructor(private readonly answers: string[]) {}
  async complete(_call: ApprovedModelCall): Promise<ProviderCompletion> {
    return { text: this.answers.length > 1 ? this.answers.shift()! : (this.answers[0] ?? "{}") };
  }
}

/** A definition that exists only in these tests; one per scope. */
function transfer(scope: "personal" | "tenant", type: string): AnyActionDefinition {
  const floor = {
    risk: "L2" as const,
    approval: { mode: "always" as const, thresholds: {} },
    requiredPermissions: scope === "tenant" ? ["impressorx:inventory.transfer"] : [],
    approverRoles: scope === "tenant" ? ["Admin"] : ["owner"],
    expiryHours: 48,
  };
  return {
    type,
    version: "1",
    scope,
    label: "Transfer stock",
    description: "Moves stock.",
    inputSchema: z.object({ n: z.number() }).strict(),
    effects: { reads: [], writes: [] },
    floor,
    defaults: { ...floor, enabled: true },
    thresholdMetrics: {},
    rollbackClass: "irreversible",
    recoveryThresholdMs: 60_000,
    executionTimeoutMs: 5_000,
    disableWarning: null,
    unavailableReason: null,
    consequenceKeys: ["metrics"],
    idempotencyKey: (input: { n: number }, ctx) => (ctx.source === "chat" ? `chat:${ctx.turnId}:${input.n}` : ctx.resourceId),
    preconditions: async () => [],
    resolve: async () => ({ ok: true, resolved: { metrics: {} } }),
    riskFor: (_r, f) => f,
    describe: (_r, input: { n: number }) => `Transfer ${input.n}`,
    execute: null,
    postconditions: async () => ({ effectCheckId: "effect", checks: [{ id: "effect", passed: true }] }),
    undo: null,
  };
}

function fixture(answers: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "link-ids-"));
  const control = openControlDb(join(dir, "control.db"));
  const gate = new ContextDbGate({ control, personalPath: join(dir, "personal.db"), tenantDir: join(dir, "tenants") });
  const identities = new SqliteIdentityRepository(control);
  const memberships = new MembershipRepository(control);
  const registrations = new TenantRegistrationRepository(control);
  const gerry = identities.createWithLogin({ kind: "google", subject: "gerry-sub" }).id;
  const personal = gate.openPersonal();
  rawDb(personal).prepare("INSERT INTO users (id, email) VALUES (?, ?)").run(gerry, "gerry@example.com");

  const registrationId = randomUUID();
  const tenantId = randomUUID();
  control
    .prepare(
      "INSERT INTO tenant_registrations (id, tenant_id, tenant_slug, display_name, origin, file_name, status, enrolled_by, enrolled_at) VALUES (?, ?, 'a', 'a', 'https://a.example', ?, 'active', ?, 'now')",
    )
    .run(registrationId, tenantId, `${registrationId}.db`, gerry);
  gate.createTenantFile(registrationId, tenantId);
  const tenantDb = gate.lease(registrationId).db;
  const membership = memberships.upsertFromHandoff({ identityId: gerry, tenantRegistrationId: registrationId, externalUserId: "a-staff", role: "Admin" });
  memberships.applySnapshot(membership.id, { role: "Admin", permissions: ["inventory.transfer"], locationIds: [], tenantStatus: "Active" });

  // Gateways as model-wiring builds them: personal audit by default, and a tenant gateway whose audit is the tenant handle's own.
  const baseDeps = {
    providers: { deepseek: new ScriptedProvider(answers) },
    overrides: new Map(),
    routing: { standard: "deepseek" as const, reasoning: "deepseek" as const },
    models: { deepseek: { standard: "flash", reasoning: "pro" } },
    choices: new SqliteAiDataChoiceRepository(rawDb(personal)),
    audit: contextRepos(personal).modelAudit,
    fingerprinter: new Fingerprinter("k".repeat(32), 1),
    maxRetries: 0,
    timeouts: { standard: 15_000, reasoning: 30_000 },
    logger,
  };
  const personalGateway = createModelGateway(baseDeps);
  const tenantGateway = createModelGateway({ ...baseDeps, auditFor: () => contextRepos(tenantDb).modelAudit });

  const actionsFor = createActionsFor({
    memberships: activeMembershipLookup(registrations, memberships),
    definitions: () => [transfer("personal", "create_calendar_event"), transfer("tenant", "inventory_transfer")],
    publicUrl: "https://oneon.test",
    calendarId: "primary",
    calendarCacheTtlMs: 60_000,
    oauthTokenRepo: null,
    deadlines: { findById: () => null },
    notificationRepo: {} as never,
    preferenceRepo: {} as never,
    notificationPort: { send: async () => undefined } as never,
    notificationWriter: {} as never,
    createGoogleTokenProvider: () => null,
    logger,
  });

  const tools = createToolRegistry();
  const personalActions = actionsFor(personal);
  for (const tool of createChatActionTools({ requestAction: personalActions.orchestrator.requestAction, registry: personalActions.registry, aiModel: "test", clock: () => new Date() })) {
    tools.register(tool);
  }
  // What a tenant chat action tool does: take the server-supplied turn and call ids and ask the tenant's own orchestrator.
  tools.register({
    name: "inventory_transfer",
    version: "1",
    description: "Request a stock transfer.",
    contexts: ["tenant"],
    inputSchema: z.object({ n: z.number(), userId: z.string().optional(), turnId: z.string().optional(), turnExcerpt: z.string().optional(), modelCallId: z.string().optional() }),
    output: { fields: { action: { class: "D1" } }, summaryClass: "D1" },
    async execute(input, scope) {
      const { n, turnId, turnExcerpt, modelCallId } = input as { n: number; turnId: string; turnExcerpt?: string; modelCallId?: string };
      const ctx = { kind: "tenant" as const, identityId: scope!.identityId, membershipId: scope!.membershipId, tenantId: scope!.tenantId, registrationId };
      const outcome = await actionsFor(tenantDb).orchestrator.requestAction({
        type: "inventory_transfer",
        input: { n },
        actor: actorForContext(ctx, memberships)!,
        initiator: "user",
        keyContext: { source: "chat", turnId },
        evidence: [{ kind: "chat_turn", source: "chat", asOf: new Date().toISOString(), data: { turnId, excerpt: turnExcerpt ?? null, model: "test" } }],
        resourceRef: null,
        ...(modelCallId ? { modelCallId } : {}),
      });
      if (outcome.kind === "refused") throw new Error(outcome.issues.join());
      const { id, actionType, status } = outcome.instance;
      return { data: { action: { id, actionType, label: "Transfer stock", status } }, summary: `Requested: ${status}` };
    },
  });

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
    resolveActiveContext({ gate, memberships, identities, snapshots: createSnapshotRefresher({ memberships, registrations, client: null, logger }), logger }),
    createChatRouter({
      conversationsFor: (req) => contextRepos(req.contextDb!).conversations,
      logger,
      modelGatewayFor: (req): ModelGateway => (req.contextDb!.kind === "tenant" ? tenantGateway : personalGateway),
      tenantActionsFor: (req) => {
        const { instanceRepo, registry } = actionsFor(req.contextDb!);
        return { instanceRepo, registry };
      },
      toolRegistry: tools,
    }),
  );

  return {
    app, personal, tenantDb, tenantId, gerry, membershipId: membership.id,
    actAs: (next: typeof session) => (session = next),
    close: () => {
      gate.close();
      control.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

type Decision = { call_id: string; purpose: string; channel: string; conversation_id: string | null; turn_id: string | null; tenant_id: string | null };
const decisionsIn = (db: ContextDb) =>
  rawDb(db).prepare("SELECT call_id, purpose, channel, conversation_id, turn_id, tenant_id FROM model_call_decisions ORDER BY created_at, rowid").all() as Decision[];
const actionsIn = (db: ContextDb) =>
  rawDb(db).prepare("SELECT id, scope, tenant_id, model_call_id FROM action_instances ORDER BY created_at, id").all() as Array<{ id: string; scope: string; tenant_id: string | null; model_call_id: string | null }>;
const joinedTurns = (db: ContextDb) =>
  rawDb(db)
    .prepare("SELECT a.id AS action_id, d.purpose, d.conversation_id, d.turn_id FROM action_instances a JOIN model_call_decisions d ON d.call_id = a.model_call_id")
    .all();

const intent = (tool: string, parameters: Record<string, unknown>) => JSON.stringify([{ tool, parameters }]);
const NONE = JSON.stringify([{ tool: "none", parameters: {} }]);

describe("link ids end to end", () => {
  const open: Array<() => void> = [];
  afterEach(() => {
    for (const close of open.splice(0)) close();
  });

  it("a tenant chat turn records the ids and the proposed action in the tenant file only", async () => {
    const f = fixture([intent("inventory_transfer", { n: 5 }), NONE, JSON.stringify({ answer: "Requested.", usedTools: ["inventory_transfer"] })]);
    open.push(f.close);
    f.actAs({ identityId: f.gerry, membershipId: f.membershipId });

    const res = await request(f.app).post("/api/chat").send({ message: "move 5 boxes to the shop" });

    expect(res.status).toBe(200);
    const { userMessageId, conversationId } = res.body as { userMessageId: string; conversationId: string };
    // The turn is the user message row, saved in the tenant file.
    expect(rawDb(f.tenantDb).prepare("SELECT role FROM conversations WHERE id = ?").get(userMessageId)).toEqual({ role: "user" });

    const decisions = decisionsIn(f.tenantDb);
    expect(decisions.map((d) => d.purpose)).toEqual(["intent_extraction", "intent_extraction", "chat_reply"]);
    for (const d of decisions) expect(d).toMatchObject({ channel: "web", conversation_id: conversationId, turn_id: userMessageId, tenant_id: f.tenantId });

    // The action was proposed by the first intent call and lives in the same file.
    const [action] = actionsIn(f.tenantDb);
    expect(actionsIn(f.tenantDb)).toHaveLength(1);
    expect(action).toMatchObject({ scope: "tenant", tenant_id: f.tenantId, model_call_id: decisions[0].call_id });
    expect(res.body.actions.map((a: { id: string }) => a.id)).toEqual([action.id]);
    expect(joinedTurns(f.tenantDb)).toEqual([{ action_id: action.id, purpose: "intent_extraction", conversation_id: conversationId, turn_id: userMessageId }]);

    // Nothing of it reached the personal file.
    expect(decisionsIn(f.personal)).toEqual([]);
    expect(actionsIn(f.personal)).toEqual([]);
  });

  it("a personal chat turn records the ids and the proposed action in the personal file only", async () => {
    const f = fixture([intent("create_calendar_event", { n: 3 }), NONE, JSON.stringify({ answer: "Requested.", usedTools: ["create_calendar_event"] })]);
    open.push(f.close);
    f.actAs({ identityId: f.gerry });

    const res = await request(f.app).post("/api/chat").send({ message: "book it", conversationId: "chat-1" });

    expect(res.status).toBe(200);
    const decisions = decisionsIn(f.personal);
    expect(decisions.map((d) => d.purpose)).toEqual(["intent_extraction", "intent_extraction", "chat_reply"]);
    for (const d of decisions) expect(d).toMatchObject({ conversation_id: "chat-1", turn_id: res.body.userMessageId, tenant_id: null });
    const [action] = actionsIn(f.personal);
    expect(actionsIn(f.personal)).toHaveLength(1);
    expect(action).toMatchObject({ scope: "personal", model_call_id: decisions[0].call_id });
    expect(joinedTurns(f.personal)).toEqual([{ action_id: action.id, purpose: "intent_extraction", conversation_id: "chat-1", turn_id: res.body.userMessageId }]);

    expect(decisionsIn(f.tenantDb)).toEqual([]);
    expect(actionsIn(f.tenantDb)).toEqual([]);
  });
});
