import { Router, type Request, type Response } from "express";
import type {
  ConversationRepository,
  IntentExtractionPort,
  SynthesisPort,
  UserProfileRepository,
  Logger,
} from "@oneon/domain";
import { sendChatMessage, type ToolRegistry } from "@oneon/application";

export interface ChatRouteDeps {
  conversationRepo: ConversationRepository;
  logger: Logger;
  userProfileRepo?: Pick<UserProfileRepository, "findByUserId"> | null;
  intentExtractor?: IntentExtractionPort | null;
  synthesizer?: SynthesisPort | null;
  toolRegistry?: ToolRegistry | null;
}

export function createChatRouter(deps: ChatRouteDeps): Router {
  const router = Router();
  const {
    conversationRepo,
    logger,
    userProfileRepo,
    intentExtractor,
    synthesizer,
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
    sendChatMessage(
      { conversationRepo, logger, intentExtractor, synthesizer, toolRegistry },
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
