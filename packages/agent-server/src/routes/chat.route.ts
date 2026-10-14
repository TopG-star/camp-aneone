import { Router, type Request, type Response } from "express";
import { TenantMismatchError } from "@oneon/domain";
import { TenantRefusedError } from "@oneon/infrastructure";
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
  type TenantToolScope,
} from "@oneon/application";

export interface ChatRouteDeps {
  /** The request's conversations: from contextRepos(req.contextDb), so a tenant's turns stay in its own file. */
  conversationsFor: (req: Request) => ConversationRepository;
  logger: Logger;
  inboundItemRepo?: Pick<InboundItemRepository, "count"> | null;
  classificationRepo?: Pick<ClassificationRepository, "count" | "findAll"> | null;
  deadlineRepo?: Pick<DeadlineRepository, "findByDateRange"> | null;
  instanceRepo?: Pick<ActionInstanceRepository, "count"> | null;
  userProfileRepo?: Pick<UserProfileRepository, "findByUserId"> | null;
  /** The request's gateway: its audit is the request's own handle, so a tenant's model calls are audited in its own file. */
  modelGatewayFor?: (req: Request) => ModelGateway | null;
  /** The request's tenant action instances and definitions (from its handle). Without it a tenant request has no model and no tools. */
  tenantActionsFor?: (req: Request) => TenantToolScope["actions"];
  /** All tools; each chat is offered, and may run, only those declared for its context. */
  toolRegistry?: ToolRegistry | null;
}

const MAX_CONVERSATION_ID_LENGTH = 128;

export function createChatRouter(deps: ChatRouteDeps): Router {
  const router = Router();
  const {
    conversationsFor,
    logger,
    userProfileRepo,
    inboundItemRepo,
    classificationRepo,
    deadlineRepo,
    instanceRepo,
    modelGatewayFor,
    tenantActionsFor,
    toolRegistry,
  } = deps;

  router.post("/", (req: Request, res: Response) => {
    // ── 1. Validate input ─────────────────────────────────
    const { message, conversationId } = req.body;

    if (typeof message !== "string" || message.trim().length === 0) {
      res.status(400).json({ error: "message is required and must be a non-empty string" });
      return;
    }

    // Bounded here: the id is copied into every model-call audit row of the turn, an append-only table.
    if (conversationId !== undefined && (typeof conversationId !== "string" || conversationId.length > MAX_CONVERSATION_ID_LENGTH)) {
      res.status(400).json({ error: `conversationId must be a string of at most ${MAX_CONVERSATION_ID_LENGTH} characters` });
      return;
    }

    // ── 2. Resolve user profile preferences ───────────────
    const userId = req.userId!;
    // A tenant context reads and writes only its own file. The personal profile and personal data are never passed to it.
    // Its model turn and tools come from the active context alone (the session), never from the request.
    const inTenant = req.contextDb?.kind === "tenant";
    const active = req.activeContext;
    const tenantScope: TenantToolScope | null =
      inTenant && active?.kind === "tenant" && tenantActionsFor
        ? { identityId: active.identityId, tenantId: active.tenantId, membershipId: active.membershipId, actions: tenantActionsFor(req) }
        : null;
    let profile = null;

    try {
      profile = inTenant ? null : (userProfileRepo?.findByUserId(userId) ?? null);
    } catch (error) {
      logger.error("Chat route: failed to load user profile", {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Internal server error" });
      return;
    }

    // ── 3. Delegate to use case ───────────────────────────
    const stats = inTenant ? null : buildChatStats({
      inboundItemRepo,
      classificationRepo,
      deadlineRepo,
      instanceRepo,
      userId,
      now: new Date(),
    });

    // The turn keeps writing to the request's handle after its awaits (the model call, then the assistant turn and the audit rows), so
    // it holds the context itself: the request's own lease ends if the client disconnects.
    const runTurn = (): Promise<void> =>
      sendChatMessage(
      {
        conversationRepo: conversationsFor(req),
        logger,
        // A tenant request whose scope did not resolve has no model and no tools (fail closed).
        modelGateway: inTenant && !tenantScope ? null : (modelGatewayFor?.(req) ?? null),
        toolRegistry: inTenant && !tenantScope ? null : toolRegistry,
        tenantScope,
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
        if (error instanceof TenantMismatchError) {
          // Spec 8.4 operator alert: a row of another context was found. No row content is logged.
          logger.error("Tenant mismatch", { code: error.code, tenantId: error.expectedTenantId, source: error.source });
        } else {
          logger.error("Chat route: failed to process message", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        res.status(500).json({ error: "Internal server error" });
      });

    try {
      void (req.holdContext ? req.holdContext(runTurn) : runTurn());
    } catch (error) {
      // The context could not be held (the request's lease had ended): the middleware's answer for that case, and nothing ran.
      if (error instanceof TenantRefusedError) {
        res.status(403).json({ error: "context_unavailable" });
        return;
      }
      // Anything else is the turn failing before its first await.
      logger.error("Chat route: failed to process message", { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: "Internal server error" });
    }
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
