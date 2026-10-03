import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { z } from "zod";
import type {
  ConversationMessage,
  ConversationRepository,
  Logger,
} from "@oneon/domain";
import { createToolRegistry } from "@oneon/application";
import { createChatRouter, type ChatRouteDeps } from "./chat.route.js";

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

function buildApp(deps: ChatRouteDeps, userId = "user-A"): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.userId = userId; next(); });
  app.use("/api/chat", createChatRouter(deps));
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
    const intentExtractor = {
      extractIntents: vi
        .fn()
        .mockResolvedValueOnce([{ tool: "create_calendar_event", parameters: {} }])
        .mockResolvedValue([{ tool: "none", parameters: {} }]),
    };
    app = buildApp({ conversationRepo, logger, intentExtractor, toolRegistry });

    const res = await request(app)
      .post("/api/chat")
      .send({ message: "Set up a call" })
      .expect(200);

    expect(res.body.actions).toEqual([action]);
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
      } as ChatRouteDeps,
    );

    await request(app)
      .post("/api/chat")
      .send({ message: "Hello" })
      .expect(200);

    expect(userProfileRepo.findByUserId).toHaveBeenCalledWith("user-A");
  });
});
