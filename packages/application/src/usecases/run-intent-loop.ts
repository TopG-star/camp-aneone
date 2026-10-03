import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Logger } from "@oneon/domain";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { ModelTurn } from "../ai-boundary/gateway.js";
import {
  buildIntentRequest,
  type ChatPersonaProfile,
  type ChatContextStats,
  type ToolCallRecord,
} from "../ai-boundary/requests/chat.js";
import type { ConversationMessage } from "@oneon/domain";

// ── Constants ────────────────────────────────────────────────

const MAX_ROUNDS = 3;
const MAX_TOOL_FAILURES = 2;

// ── Intent Output Schema (Refinement #2) ─────────────────────

export const intentOutputSchema = z.array(
  z.object({
    tool: z.string().min(1),
    parameters: z.record(z.unknown()),
  })
);

// ── Types ────────────────────────────────────────────────────

export type { ToolCallRecord } from "../ai-boundary/requests/chat.js";

export type StopReason =
  | "no_intents"
  | "none_intent"
  | "max_rounds"
  | "all_tools_failed"
  | "invalid_intents"
  | "extraction_error"
  | "policy_denied";

export interface RunIntentLoopDeps {
  modelTurn: ModelTurn;
  toolRegistry: ToolRegistry;
  logger: Logger;
}

export interface RunIntentLoopInput {
  userMessage: string;
  userId?: string;
  /** The persisted user message ID for this turn; injected into tool calls for idempotency. */
  turnId?: string;
  history: ConversationMessage[];
  toolDefinitions: Array<{ name: string; description: string }>;
  stats: ChatContextStats;
  now: Date;
  timezone: string;
  persona?: ChatPersonaProfile | null;
}

export interface RunIntentLoopResult {
  toolCalls: ToolCallRecord[];
  rounds: number;
  stopped: StopReason;
}

// ── Loop Implementation ──────────────────────────────────────

export async function runIntentLoop(
  deps: RunIntentLoopDeps,
  input: RunIntentLoopInput
): Promise<RunIntentLoopResult> {
  const { modelTurn, toolRegistry, logger } = deps;
  const { userMessage, history, toolDefinitions, stats, now, timezone, persona, userId, turnId } = input;

  const allToolCalls: ToolCallRecord[] = [];
  const executedSet = new Set<string>(); // Refinement #3: dedupe
  const toolFailCounts = new Map<string, number>(); // Refinement #8: failure tracking
  let stopped: StopReason = "max_rounds";

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    // One request per round; the gateway decides what the model may see.
    const result = await modelTurn.call(
      buildIntentRequest({
        userMessage,
        history,
        toolDefinitions,
        stats,
        now,
        timezone,
        persona: persona ?? null,
        toolCalls: allToolCalls,
        registry: toolRegistry,
      }),
    );
    if (result.kind === "denied") {
      logger.info("Intent extraction denied by AI data policy", { round, reason: result.reason });
      stopped = "policy_denied";
      return { toolCalls: allToolCalls, rounds: round, stopped };
    }
    if (result.kind !== "answered") {
      logger.error("Intent extraction failed", { round, kind: result.kind });
      stopped = "extraction_error";
      return { toolCalls: allToolCalls, rounds: round, stopped };
    }
    const rawIntents = result.json;

    // Refinement #2: Zod-validate intent output
    const parsed = intentOutputSchema.safeParse(rawIntents);
    if (!parsed.success) {
      logger.warn("Intent output failed Zod validation", {
        round,
        errors: parsed.error.issues,
      });
      stopped = "invalid_intents";
      return { toolCalls: allToolCalls, rounds: round, stopped };
    }
    const intents = parsed.data;

    // FR-045: Stop if empty intents
    if (intents.length === 0) {
      stopped = "no_intents";
      return { toolCalls: allToolCalls, rounds: round, stopped };
    }

    // FR-045: Stop if none intent present
    if (intents.some((i) => i.tool === "none")) {
      stopped = "none_intent";
      return { toolCalls: allToolCalls, rounds: round, stopped };
    }

    // Execute each intent
    let anyToolExecuted = false;

    for (let intent of intents) {
      // Placeholders the model used go back to real values before anything else sees the parameters.
      const restored = modelTurn.restoreToolParams(intent.parameters);
      if (!restored.ok) {
        logger.warn("Model used an unknown placeholder", { tool: intent.tool, token: restored.token, round });
        continue;
      }
      intent = { ...intent, parameters: restored.params };

      // Refinement #3: dedupe by tool + serialized parameters
      const dedupeKey = `${intent.tool}:${JSON.stringify(intent.parameters)}`;
      if (executedSet.has(dedupeKey)) {
        logger.warn("Duplicate tool call skipped", {
          tool: intent.tool,
          round,
        });
        continue;
      }
      executedSet.add(dedupeKey);

      // Refinement #8: skip tools that have failed too many times
      const failCount = toolFailCounts.get(intent.tool) ?? 0;
      if (failCount >= MAX_TOOL_FAILURES) {
        logger.warn("Tool call skipped — too many failures this turn", {
          tool: intent.tool,
          failCount,
          round,
        });
        continue;
      }

      // Execute the tool
      anyToolExecuted = true;
      const startTime = performance.now();
      try {
        // Identity comes from the server only: drop any AI-supplied reserved keys first.
        const { userId: _u, turnId: _t, turnExcerpt: _e, ...aiParams } = intent.parameters;
        const executionParameters = {
          ...aiParams,
          ...(userId ? { userId } : {}),
          ...(turnId ? { turnId, turnExcerpt: userMessage.slice(0, 280) } : {}),
        };
        const result = await toolRegistry.execute(intent.tool, executionParameters);
        const durationMs =
          Math.round((performance.now() - startTime) * 100) / 100;

        allToolCalls.push({
          id: randomUUID(),
          round,
          tool: intent.tool,
          parameters: intent.parameters as Record<string, unknown>,
          result: { data: result.data, summary: result.summary },
          error: null,
          durationMs,
          executedAt: new Date().toISOString(),
        });
      } catch (error) {
        const durationMs =
          Math.round((performance.now() - startTime) * 100) / 100;
        const errorMessage =
          error instanceof Error ? error.message : String(error);

        toolFailCounts.set(intent.tool, failCount + 1);

        allToolCalls.push({
          id: randomUUID(),
          round,
          tool: intent.tool,
          parameters: intent.parameters as Record<string, unknown>,
          result: null,
          error: errorMessage,
          durationMs,
          executedAt: new Date().toISOString(),
        });

        logger.warn("Tool execution failed", {
          tool: intent.tool,
          round,
          error: errorMessage,
        });
      }
    }

    // Refinement #8: if no tools were executed (all skipped), stop
    if (!anyToolExecuted) {
      stopped = "all_tools_failed";
      return { toolCalls: allToolCalls, rounds: round, stopped };
    }
  }

  return { toolCalls: allToolCalls, rounds: MAX_ROUNDS, stopped };
}
