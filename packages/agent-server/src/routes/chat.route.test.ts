import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { z } from "zod";
import type {
  ActionInstanceRepository,
  ActiveContext,
  ContextDb,
  ConversationMessage,
  ConversationRepository,
  Logger,
} from "@oneon/domain";
import {
  createActionRegistry,
  createListPendingActionsTool,
  createShowMyAccessTool,
  createToolRegistry,
  type ModelContext,
  type ModelGateway,
} from "@oneon/application";
import { createChatRouter, type ChatRouteDeps } from "./chat.route.js";
import type { Request } from "express";

// ── Helpers ──────────────────────────────────────────────────

function createMockConversationRepo(
  overrides: Partial<ConversationRepository> = {}
): ConversationRepository {
  let callCount = 0;
  return {
    append: vi.fn().mockImplementation((msg) => {
      callCount++;
      return {
        id: `msg-${String(callCount).padStart(3, "0")}`,
        userId: null,
        conversationId: msg.conversationId,
        role: msg.role,
        content: msg.content,
        toolCalls: msg.toolCalls,
        createdAt: "2026-04-16T09:00:00Z",
      } satisfies ConversationMessage;
    }),
    findRecentByConversation: vi.fn().mockReturnValue([]),
    countByConversation: vi.fn().mockReturnValue(0),
    count: vi.fn().mockReturnValue(0),
    ...overrides,
  };
}

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

type TestDeps = Omit<ChatRouteDeps, "conversationsFor" | "modelGatewayFor" | "tenantActionsFor"> &
  Partial<Pick<ChatRouteDeps, "modelGatewayFor" | "tenantActionsFor">> & { conversationRepo: ConversationRepository; modelGateway?: ModelGateway | null };

/** `context` is what resolveActiveContext would have set on the request. */
function buildApp(
  { conversationRepo, modelGateway, modelGatewayFor, tenantActionsFor, ...deps }: TestDeps,
  userId = "user-A",
  context: { active?: ActiveContext; db: ContextDb } | null = null,
): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = userId;
    if (context) {
      req.activeContext = context.active;
      req.contextDb = context.db;
    }
    next();
  });
  app.use("/api/chat", createChatRouter({
    ...deps,
    conversationsFor: () => conversationRepo,
    modelGatewayFor: modelGatewayFor ?? (() => modelGateway ?? null),
    tenantActionsFor: tenantActionsFor ?? (() => { throw new Error("no tenant actions in this test"); }),
  }));
  return app;
}

// ── Tests ────────────────────────────────────────────────────

describe("POST /api/chat", () => {
  let logger: Logger;
  let conversationRepo: ConversationRepository;
  let app: express.Express;

  beforeEach(() => {
    logger = createMockLogger();
    conversationRepo = createMockConversationRepo();
    app = buildApp({ conversationRepo, logger });
  });

  // ── Validation ─────────────────────────────────────────────

  it("returns 400 when message is missing", async () => {
    const res = await request(app)
      .post("/api/chat")
      .send({})
      .expect(400);

    expect(res.body.error).toContain("message");
  });

  it("returns 400 when message is empty string", async () => {
    const res = await request(app)
      .post("/api/chat")
      .send({ message: "" })
      .expect(400);

    expect(res.body.error).toContain("message");
  });

  it("returns 400 when message is not a string", async () => {
    const res = await request(app)
      .post("/api/chat")
      .send({ message: 123 })
      .expect(400);

    expect(res.body.error).toContain("message");
  });

  it("returns 400 when conversationId is not a string", async () => {
    const res = await request(app)
      .post("/api/chat")
      .send({ message: "Hello", conversationId: 42 })
      .expect(400);

    expect(res.body.error).toContain("conversationId");
  });

  // ── Successful request ─────────────────────────────────────

  it("returns 200 with response for valid message", async () => {
    const res = await request(app)
      .post("/api/chat")
      .send({ message: "Hello Oneon" })
      .expect(200);

    expect(res.body.response).toBeTruthy();
    expect(res.body.userMessageId).toBe("msg-001");
    expect(res.body.assistantMessageId).toBe("msg-002");
    expect(res.body.conversationId).toBeTruthy();
  });

  it("returns the provided conversationId", async () => {
    const res = await request(app)
      .post("/api/chat")
      .send({ message: "Hello", conversationId: "conv-existing" })
      .expect(200);

    expect(res.body.conversationId).toBe("conv-existing");
  });

  it("returns history array", async () => {
    const res = await request(app)
      .post("/api/chat")
      .send({ message: "Hello" })
      .expect(200);

    expect(Array.isArray(res.body.history)).toBe(true);
  });

  it("returns an empty actions array when no action was requested", async () => {
    const res = await request(app)
      .post("/api/chat")
      .send({ message: "Hello" })
      .expect(200);

    expect(res.body.actions).toEqual([]);
  });

  it("returns the actions the use case reports", async () => {
    const action = {
      id: "a1",
      actionType: "create_calendar_event",
      label: "Create calendar event",
      status: "awaiting_approval",
    };
    const toolRegistry = createToolRegistry();
    toolRegistry.register({
      name: "create_calendar_event",
      version: "2.0.0",
      description: "stub",
      inputSchema: z.object({}).passthrough(),
      output: { fields: {}, summaryClass: "D1" },
      execute: () => ({ data: { action }, summary: "Waiting for your approval." }),
    });
    // Intent rounds: request the action, then stop. The chat reply is denied, so tool summaries answer.
    let intentRounds = 0;
    const modelGateway: ModelGateway = {
      beginTurn: () => ({
        call: async (req) =>
          req.purpose === "chat_reply"
            ? { kind: "denied", reason: "required_part_withheld", withheld: [], decisionId: "d", callId: "c" }
            : {
                kind: "answered",
                text: "",
                json: intentRounds++ === 0 ? [{ tool: "create_calendar_event", parameters: {} }] : [{ tool: "none", parameters: {} }],
                withheld: [],
                decisionId: "d",
                callId: "c",
              },
        restoreToolParams: (params) => ({ ok: true, params }),
        effectiveLimit: () => "D2",
      }),
    };
    app = buildApp({ conversationRepo, logger, modelGateway, toolRegistry });

    const res = await request(app)
      .post("/api/chat")
      .send({ message: "Set up a call" })
      .expect(200);

    expect(res.body.actions).toEqual([action]);
  });

  it("begins the model turn linked to its conversation and to the user message that started it", async () => {
    const beginTurn = vi.fn((_context: ModelContext, _options?: { channel?: string; conversationId?: string; turnId?: string }) => ({
      call: async () => ({ kind: "denied", reason: "required_part_withheld", withheld: [], decisionId: "d", callId: "c" }) as const,
      restoreToolParams: (params: Record<string, unknown>) => ({ ok: true as const, params }),
      effectiveLimit: () => "D2" as const,
    }));
    app = buildApp({ conversationRepo, logger, modelGateway: { beginTurn } as unknown as ModelGateway, toolRegistry: createToolRegistry() });

    const res = await request(app).post("/api/chat").send({ message: "Hello", conversationId: "conv-9" }).expect(200);

    // The user message row is saved before the model is asked, and its id is the turn.
    expect(res.body.userMessageId).toBe("msg-001");
    expect(beginTurn).toHaveBeenCalledWith(
      { kind: "personal", identityId: "user-A" },
      { channel: "web", conversationId: "conv-9", turnId: res.body.userMessageId },
    );
  });

  it("counts only the session user's actions awaiting approval", async () => {
    const instanceRepo = { count: vi.fn().mockReturnValue(3) };
    app = buildApp({
      conversationRepo,
      logger,
      inboundItemRepo: { count: vi.fn().mockReturnValue(0) },
      classificationRepo: { count: vi.fn().mockReturnValue(0), findAll: vi.fn().mockReturnValue([]) },
      deadlineRepo: { findByDateRange: vi.fn().mockReturnValue([]) },
      instanceRepo,
    });

    await request(app).post("/api/chat").send({ message: "Hello" }).expect(200);

    expect(instanceRepo.count).toHaveBeenCalledWith("user-A", { statuses: ["awaiting_approval"] });
  });

  // ── Error handling ─────────────────────────────────────────

  it("returns 500 when conversationRepo.append throws", async () => {
    conversationRepo = createMockConversationRepo({
      append: vi.fn().mockImplementation(() => {
        throw new Error("DB failure");
      }),
    });
    app = buildApp({ conversationRepo, logger });

    const res = await request(app)
      .post("/api/chat")
      .send({ message: "Hello" })
      .expect(500);

    expect(res.body.error).toBe("Internal server error");
    expect(logger.error).toHaveBeenCalled();
  });

  it("loads user profile settings before chat processing", async () => {
    const userProfileRepo = {
      findByUserId: vi.fn().mockReturnValue({
        userId: "user-A",
        preferredName: "Adewale",
        nickname: "Wale",
        salutationMode: "sir_with_name",
        communicationStyle: "technical",
        timezone: "Africa/Lagos",
        createdAt: "2026-04-17T00:00:00.000Z",
        updatedAt: "2026-04-17T00:00:00.000Z",
      }),
    };

    app = buildApp(
      {
        conversationRepo,
        logger,
        // Cast here so we can drive RED first before adding route dep typing.
        userProfileRepo,
      } as TestDeps,
    );

    await request(app)
      .post("/api/chat")
      .send({ message: "Hello" })
      .expect(200);

    expect(userProfileRepo.findByUserId).toHaveBeenCalledWith("user-A");
  });
});

// ── Tenant context ───────────────────────────────────────────

describe("POST /api/chat in a tenant context", () => {
  const active: ActiveContext = { kind: "tenant", identityId: "i1", membershipId: "m1", tenantId: "t1", registrationId: "r1" };
  const handle: ContextDb = { kind: "tenant", tenantId: "t1", raw: {}, __brand: "TenantDb" };
  const membership = { identityId: "i1", status: "active", role: "Admin", permissions: ["inventory.view"], locationIds: ["loc-1"], snapshotAt: "2026-10-08T09:00:00.000Z" };
  const personalTool = vi.fn(() => ({ data: [], summary: "personal" }));
  const actions = { instanceRepo: { list: vi.fn(() => []) } as unknown as ActionInstanceRepository, registry: createActionRegistry([]) };

  function tenantRegistry(findById: (id: string) => typeof membership | null = () => membership) {
    const registry = createToolRegistry();
    registry.register({
      name: "list_inbox",
      version: "1",
      description: "personal inbox",
      contexts: ["personal"],
      inputSchema: z.object({}).passthrough(),
      output: { fields: {}, summaryClass: "D1" },
      execute: personalTool,
    });
    registry.register(createListPendingActionsTool({ instanceRepo: { list: vi.fn() } as unknown as ActionInstanceRepository, registry: createActionRegistry([]) }));
    registry.register(createShowMyAccessTool({ memberships: { findById } }));
    return registry;
  }

  /** Intent rounds follow the script; the chat reply is denied so the tool summaries answer. */
  function scripted(intents: Array<Array<{ tool: string; parameters: Record<string, unknown> }>>) {
    const requests: Array<{ purpose: string; parts: unknown[] }> = [];
    let round = 0;
    const beginTurn = vi.fn((_context: ModelContext, _options?: { channel?: string; conversationId?: string; turnId?: string }) => ({
      call: async (req: { purpose: string; parts: unknown[] }) => {
        requests.push(req);
        return req.purpose === "chat_reply"
          ? ({ kind: "denied", reason: "required_part_withheld", withheld: [], decisionId: "d", callId: "c" } as const)
          : ({ kind: "answered", text: "", json: intents[round++] ?? [{ tool: "none", parameters: {} }], withheld: [], decisionId: "d", callId: "c" } as const);
      },
      restoreToolParams: (params: Record<string, unknown>) => ({ ok: true as const, params }),
      effectiveLimit: () => "D1" as const,
    }));
    return { gateway: { beginTurn } as unknown as ModelGateway, beginTurn, requests };
  }

  const tenantApp = (deps: Partial<TestDeps>) =>
    buildApp({ conversationRepo: createMockConversationRepo(), logger: createMockLogger(), tenantActionsFor: () => actions, ...deps }, "i1", { active, db: handle });

  beforeEach(() => personalTool.mockClear());

  it("asks for the gateway of the request's own handle", async () => {
    const { gateway } = scripted([]);
    const modelGatewayFor = vi.fn((_req: Request) => gateway);

    await request(tenantApp({ modelGatewayFor, toolRegistry: tenantRegistry() })).post("/api/chat").send({ message: "hello" }).expect(200);

    expect(modelGatewayFor).toHaveBeenCalledTimes(1);
    expect(modelGatewayFor.mock.calls[0][0].contextDb).toBe(handle);
  });

  it("begins the turn with the tenant model context and offers only the tenant tools", async () => {
    const { gateway, beginTurn, requests } = scripted([]);

    await request(tenantApp({ modelGateway: gateway, toolRegistry: tenantRegistry() })).post("/api/chat").send({ message: "what can you do?" }).expect(200);

    expect(beginTurn).toHaveBeenCalledWith({ kind: "tenant", identityId: "i1", tenantId: "t1", membershipId: "m1" }, { channel: "web", conversationId: "user:i1", turnId: "msg-001" });
    expect(requests[0].parts).toContainEqual(
      expect.objectContaining({ kind: "tool_catalog", tools: [expect.objectContaining({ name: "list_pending_actions" }), expect.objectContaining({ name: "show_my_access" })] }),
    );
  });

  it("shows the person their own access, from the membership the session names", async () => {
    const findById = vi.fn(() => membership);
    const { gateway } = scripted([[{ tool: "show_my_access", parameters: { membershipId: "m-other" } }]]);

    const res = await request(tenantApp({ modelGateway: gateway, toolRegistry: tenantRegistry(findById) })).post("/api/chat").send({ message: "what is my role?" }).expect(200);

    expect(findById).toHaveBeenCalledWith("m1");
    expect(res.body.response).toContain("Role Admin");
  });

  it("does not run a personal tool the model asks for in a tenant context", async () => {
    const { gateway } = scripted([[{ tool: "list_inbox", parameters: {} }]]);

    await request(tenantApp({ modelGateway: gateway, toolRegistry: tenantRegistry() })).post("/api/chat").send({ message: "read my mail" }).expect(200);

    expect(personalTool).not.toHaveBeenCalled();
  });

  it("gives a tenant request no model and no tools when its context is not fully resolved", async () => {
    const { gateway, beginTurn } = scripted([]);
    const modelGatewayFor = vi.fn((_req: Request) => gateway);
    const app = buildApp({ conversationRepo: createMockConversationRepo(), logger: createMockLogger(), modelGatewayFor, toolRegistry: tenantRegistry() }, "i1", { db: handle });

    const res = await request(app).post("/api/chat").send({ message: "hello" }).expect(200);

    expect(beginTurn).not.toHaveBeenCalled();
    expect(res.body.response).toContain("not connected to tools");
  });
});
