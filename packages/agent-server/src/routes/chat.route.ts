import { Router, type Request, type Response } from "express";
import type {
  ConversationRepository,
  UserProfileRepository,
  InboundItemRepository,
  ClassificationRepository,
  DeadlineRepository,
  ActionInstanceRepository,
  Logger,
} from "@oneon/domain";
import {
  sendChatMessage,
  type ToolRegistry,
  type ModelGateway,
  type ChatContextStats,
} from "@oneon/application";

export interface ChatRouteDeps {
  conversationRepo: ConversationRepository;
  logger: Logger;
  inboundItemRepo?: Pick<InboundItemRepository, "count"> | null;
  classificationRepo?: Pick<ClassificationRepository, "count" | "findAll"> | null;
  deadlineRepo?: Pick<DeadlineRepository, "findByDateRange"> | null;
  instanceRepo?: Pick<ActionInstanceRepository, "count"> | null;
  userProfileRepo?: Pick<UserProfileRepository, "findByUserId"> | null;
  modelGateway?: ModelGateway | null;
  toolRegistry?: ToolRegistry | null;
}

export function createChatRouter(deps: ChatRouteDeps): Router {
  const router = Router();
  const {
    conversationRepo,
    logger,
    userProfileRepo,
    inboundItemRepo,
    classificationRepo,
    deadlineRepo,
    instanceRepo,
    modelGateway,
    toolRegistry,
  } = deps;

  router.post("/", (req: Request, res: Response) => {
    // ── 1. Validate input ─────────────────────────────────
    const { message, conversationId } = req.body;

    if (typeof message !== "string" || message.trim().length === 0) {
      res.status(400).json({ error: "message is required and must be a non-empty string" });
      return;
    }

    if (conversationId !== undefined && typeof conversationId !== "string") {
      res.status(400).json({ error: "conversationId must be a string" });
      return;
    }

    // ── 2. Resolve user profile preferences ───────────────
    const userId = req.userId!;
    let profile = null;

    try {
      profile = userProfileRepo?.findByUserId(userId) ?? null;
    } catch (error) {
      logger.error("Chat route: failed to load user profile", {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Internal server error" });
      return;
    }

    // ── 3. Delegate to use case ───────────────────────────
    const stats = buildChatStats({
      inboundItemRepo,
      classificationRepo,
      deadlineRepo,
      instanceRepo,
      userId,
      now: new Date(),
    });

    sendChatMessage(
      {
        conversationRepo,
        logger,
        modelGateway,
        toolRegistry,
        stats,
      },
      {
        message: message.trim(),
        conversationId: conversationId || undefined,
        userId,
        timezone: profile?.timezone ?? "UTC",
        persona: profile
          ? {
              preferredName: profile.preferredName,
              nickname: profile.nickname,
              salutationMode: profile.salutationMode,
              communicationStyle: profile.communicationStyle,
            }
          : null,
      }
    )
      .then((result) => {
        res.status(200).json({
          response: result.response,
          userMessageId: result.userMessageId,
          assistantMessageId: result.assistantMessageId,
          conversationId: result.conversationId,
          history: result.history,
          actions: result.actions,
        });
      })
      .catch((error) => {
        logger.error("Chat route: failed to process message", {
          error: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "Internal server error" });
      });
  });

  return router;
}

function buildChatStats(input: {
  inboundItemRepo?: Pick<InboundItemRepository, "count"> | null;
  classificationRepo?: Pick<ClassificationRepository, "count" | "findAll"> | null;
  deadlineRepo?: Pick<DeadlineRepository, "findByDateRange"> | null;
  instanceRepo?: Pick<ActionInstanceRepository, "count"> | null;
  userId: string;
  now: Date;
}): ChatContextStats | null {
  const {
    inboundItemRepo,
    classificationRepo,
    deadlineRepo,
    instanceRepo,
    userId,
    now,
  } = input;

  if (!inboundItemRepo || !classificationRepo || !deadlineRepo || !instanceRepo) {
    return null;
  }

  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const upcomingDeadlinesCount = deadlineRepo.findByDateRange(
    now.toISOString(),
    new Date(now.getTime() + sevenDaysMs).toISOString(),
    "open",
    userId,
  ).length;

  const followUpCount = classificationRepo
    .findAll({ limit: 500, userId })
    .filter((classification) => classification.followUpNeeded).length;

  return {
    totalInboxItems: inboundItemRepo.count({ userId }),
    unreadUrgentCount: classificationRepo.count({ category: "urgent", userId }),
    pendingActionsCount: instanceRepo.count(userId, { statuses: ["awaiting_approval"] }),
    upcomingDeadlinesCount,
    followUpCount,
  };
}
