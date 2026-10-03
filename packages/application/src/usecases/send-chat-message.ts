import type {
  ConversationMessage,
  ConversationRepository,
  Logger,
} from "@oneon/domain";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { ChatActionRef } from "../actions/chat-action-tools.js";
import { truncateHistory } from "./truncate-history.js";
import { runIntentLoop, errorName } from "./run-intent-loop.js";
import { synthesizeResponse, DATA_WITHHELD_NOTE } from "./synthesize-response.js";
import type { ModelGateway } from "../ai-boundary/gateway.js";
import type {
  ChatContextStats,
  ChatPersonaProfile,
} from "../ai-boundary/requests/chat.js";

// ── Types ────────────────────────────────────────────────────

export interface SendChatMessageDeps {
  conversationRepo: ConversationRepository;
  logger: Logger;
  modelGateway?: ModelGateway | null;
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
  actions: ChatActionRef[];
}

// ── Constants ────────────────────────────────────────────────

const PLACEHOLDER_RESPONSE = "I'm not connected to tools yet. This will be upgraded once the tool registry and intent extraction loop are wired in.";
export const SECRET_DENIED_MESSAGE = "A recent message looks like it contains a password or key, so it wasn't sent to the AI.";
export const PROVIDER_UNAVAILABLE_MESSAGE = "The AI is unavailable right now.";
export const POLICY_DENIED_MESSAGE = "Your AI data settings stopped this message from being sent to the AI.";
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
  let actions: ChatActionRef[] = [];

  const canRunLoop =
    deps.modelGateway != null &&
    deps.toolRegistry != null;

  if (canRunLoop) {
    // One turn per message: placeholders stay the same across the intent rounds and the reply.
    const turn = deps.modelGateway!.beginTurn({ kind: "personal", identityId: userId }, { channel: "web" });
    const loopResult = await runIntentLoop(
      {
        modelTurn: turn,
        toolRegistry: deps.toolRegistry!,
        logger,
      },
      {
        userMessage: input.message,
        userId,
        turnId: userMsg.id,
        history: truncateHistory(history, TRUNCATE_OPTIONS),
        toolDefinitions: deps.toolRegistry!.list(),
        stats: deps.stats ?? defaultStats(),
        now: input.now ?? new Date(),
        timezone: input.timezone ?? "UTC",
        persona: input.persona ?? null,
      }
    );

    actions = loopResult.toolCalls
      .map((tc) => (tc.result?.data as { action?: ChatActionRef } | null | undefined)?.action)
      .filter((a): a is ChatActionRef => !!a);

    // Refinement #7: persist tool calls for audit
    if (loopResult.toolCalls.length > 0) {
      toolCallsJson = JSON.stringify(loopResult.toolCalls);
    }

    // Tool summaries are the fallback whenever the model reply is not available.
    const summaryFallback = (): string => {
      const summaries = loopResult.toolCalls
        .filter((tc) => tc.result !== null)
        .map((tc) => tc.result!.summary);
      return summaries.length > 0 ? summaries.join("\n") : FALLBACK_RESPONSE;
    };

    if (loopResult.toolCalls.length > 0) {
      try {
        const synthesis = await synthesizeResponse(
          { modelTurn: turn, logger },
          {
            userMessage: input.message,
            toolCalls: loopResult.toolCalls,
            history: truncateHistory(history, TRUNCATE_OPTIONS),
            persona: input.persona ?? null,
            registry: deps.toolRegistry!,
          },
        );
        const note = synthesis.dataWithheld ? `\n\n${DATA_WITHHELD_NOTE}` : "";
        response = (synthesis.kind === "answered" ? synthesis.response.answer : summaryFallback()) + note;
      } catch (error) {
        // Never log the error text: it may carry prompt or tool data.
        logger.error("Chat reply failed unexpectedly, using tool summaries as fallback", {
          errorName: errorName(error),
        });
        response = summaryFallback();
      }
    } else {
      response =
        loopResult.stopped === "policy_denied"
          ? deniedMessage(loopResult.deniedReason)
          : FALLBACK_RESPONSE;
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
    actions,
  };
}

// ── Helpers ──────────────────────────────────────────────────

function deniedMessage(reason: string | undefined): string {
  if (reason === "secret_present") return SECRET_DENIED_MESSAGE;
  if (reason === "provider_unavailable") return PROVIDER_UNAVAILABLE_MESSAGE;
  return POLICY_DENIED_MESSAGE;
}

function defaultStats(): ChatContextStats {
  return {
    totalInboxItems: 0,
    unreadUrgentCount: 0,
    pendingActionsCount: 0,
    upcomingDeadlinesCount: 0,
    followUpCount: 0,
  };
}
