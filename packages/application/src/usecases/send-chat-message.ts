import type {
  ConversationMessage,
  ConversationRepository,
  IntentExtractionPort,
  SynthesisPort,
  Logger,
} from "@oneon/domain";
import type { ToolRegistry } from "../tools/tool-registry.js";
import { truncateHistory } from "./truncate-history.js";
import { runIntentLoop } from "./run-intent-loop.js";
import { synthesizeResponse } from "./synthesize-response.js";
import type {
  ChatContextStats,
  ChatPersonaProfile,
} from "./build-chat-context.js";

// ── Types ────────────────────────────────────────────────────

export interface SendChatMessageDeps {
  conversationRepo: ConversationRepository;
  logger: Logger;
  intentExtractor?: IntentExtractionPort | null;
  synthesizer?: SynthesisPort | null;
  toolRegistry?: ToolRegistry | null;
  stats?: ChatContextStats | null;
}

export interface SendChatMessageInput {
  message: string;
  conversationId?: string;
  userId: string;
  now?: Date;
  timezone?: string;
  persona?: ChatPersonaProfile | null;
}

export interface SendChatMessageResult {
  userMessageId: string;
  assistantMessageId: string;
  conversationId: string;
  response: string;
  history: ConversationMessage[];
}

// ── Constants ────────────────────────────────────────────────

const PLACEHOLDER_RESPONSE = "I'm not connected to tools yet. This will be upgraded once the tool registry and intent extraction loop are wired in.";
const FALLBACK_RESPONSE = "I ran into trouble processing your request. Please try again.";
const HISTORY_LIMIT = 20;
const TRUNCATE_OPTIONS = {
  maxMessages: 20,
  maxCharsPerMessage: 2000,
  totalBudget: 30_000,
};

// ── Use Case ─────────────────────────────────────────────────

export async function sendChatMessage(
  deps: SendChatMessageDeps,
  input: SendChatMessageInput
): Promise<SendChatMessageResult> {
  const { conversationRepo, logger } = deps;
  const userId = input.userId;
  const conversationId = input.conversationId ?? `user:${userId}`;

  // 1. Retrieve existing history for context (before appending new messages)
  const history = conversationRepo.findRecentByConversation(
    conversationId,
    HISTORY_LIMIT,
    userId
  );

  // 2. Persist the user message
  const userMsg = conversationRepo.append({
    userId,
    conversationId,
    role: "user",
    content: input.message,
    toolCalls: null,
  });

  // 3. Generate response — intent loop or placeholder
  let response: string;
  let toolCallsJson: string | null = null;

  const canRunLoop =
    deps.intentExtractor != null &&
    deps.toolRegistry != null;

  if (canRunLoop) {
    const loopResult = await runIntentLoop(
      {
        intentExtractor: deps.intentExtractor!,
        toolRegistry: deps.toolRegistry!,
        logger,
      },
      {
        userMessage: input.message,
        history: truncateHistory(history, TRUNCATE_OPTIONS),
        toolDefinitions: deps.toolRegistry!.list(),
        stats: deps.stats ?? defaultStats(),
        now: input.now ?? new Date(),
        timezone: input.timezone ?? "UTC",
        persona: input.persona ?? null,
      }
    );

    // Refinement #7: persist tool calls for audit
    if (loopResult.toolCalls.length > 0) {
      toolCallsJson = JSON.stringify(loopResult.toolCalls);
    }

    // Synthesize final response
    if (deps.synthesizer != null && loopResult.toolCalls.length > 0) {
      try {
        const synthesisResult = await synthesizeResponse(
          { synthesizer: deps.synthesizer, logger },
          {
            userMessage: input.message,
            toolCalls: loopResult.toolCalls,
            history: truncateHistory(history, TRUNCATE_OPTIONS),
            persona: input.persona ?? null,
          }
        );
        response = synthesisResult.response.answer;
        logger.debug("Synthesis completed", synthesisResult.meta);
      } catch (error) {
        logger.error("Synthesis failed, using tool summaries as fallback", {
          error: error instanceof Error ? error.message : String(error),
        });
        const summaries = loopResult.toolCalls
          .filter((tc) => tc.result !== null)
          .map((tc) => tc.result!.summary);
        response = summaries.length > 0 ? summaries.join("\n") : FALLBACK_RESPONSE;
      }
    } else if (loopResult.toolCalls.length > 0) {
      const summaries = loopResult.toolCalls
        .filter((tc) => tc.result !== null)
        .map((tc) => tc.result!.summary);
      response = summaries.length > 0 ? summaries.join("\n") : FALLBACK_RESPONSE;
    } else {
      response = FALLBACK_RESPONSE;
    }
  } else {
    response = PLACEHOLDER_RESPONSE;
  }

  // 4. Persist the assistant response
  const assistantMsg = conversationRepo.append({
    userId,
    conversationId,
    role: "assistant",
    content: response,
    toolCalls: toolCallsJson,
  });

  logger.info("Chat message processed", {
    conversationId,
    userMessageId: userMsg.id,
    assistantMessageId: assistantMsg.id,
    historyLength: history.length,
  });

  return {
    userMessageId: userMsg.id,
    assistantMessageId: assistantMsg.id,
    conversationId,
    response,
    history,
  };
}

// ── Helpers ──────────────────────────────────────────────────

function defaultStats(): ChatContextStats {
  return {
    totalInboxItems: 0,
    unreadUrgentCount: 0,
    pendingActionsCount: 0,
    upcomingDeadlinesCount: 0,
    followUpCount: 0,
  };
}
