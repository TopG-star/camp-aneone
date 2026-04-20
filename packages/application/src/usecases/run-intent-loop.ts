import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { IntentExtractionPort, Logger } from "@oneon/domain";
import type { ToolRegistry } from "../tools/tool-registry.js";
import {
  buildChatContext,
  type ChatContextStats,
  type ToolCallRecord,
} from "./build-chat-context.js";
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

export type { ToolCallRecord } from "./build-chat-context.js";

export type StopReason =
  | "no_intents"
  | "none_intent"
  | "max_rounds"
  | "all_tools_failed"
  | "invalid_intents"
  | "extraction_error";

export interface RunIntentLoopDeps {
  intentExtractor: IntentExtractionPort;
  toolRegistry: ToolRegistry;
  logger: Logger;
}

export interface RunIntentLoopInput {
  userMessage: string;
  history: ConversationMessage[];
  toolDefinitions: Array<{ name: string; description: string }>;
  stats: ChatContextStats;
  now: Date;
  timezone: string;
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
  const { intentExtractor, toolRegistry, logger } = deps;
  const { userMessage, history, toolDefinitions, stats, now, timezone } = input;

  const allToolCalls: ToolCallRecord[] = [];
  const executedSet = new Set<string>(); // Refinement #3: dedupe
  const toolFailCounts = new Map<string, number>(); // Refinement #8: failure tracking
  let stopped: StopReason = "max_rounds";

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    // Build context with growing action history
    const context = buildChatContext({
      stats,
      history,
      toolDefinitions,
      executedActions: allToolCalls,
      now,
      timezone,
    });

    // Extract intents from LLM
    let rawIntents: Array<{ tool: string; parameters: Record<string, unknown> }>;
    try {
      rawIntents = await intentExtractor.extractIntents(userMessage, context);
    } catch (error) {
      logger.error("Intent extraction failed", {
        round,
        error: error instanceof Error ? error.message : String(error),
      });
      stopped = "extraction_error";
      return { toolCalls: allToolCalls, rounds: round, stopped };
    }

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

    for (const intent of intents) {
      // Refinement #3: dedupe by tool + serialized parameters
      const dedupeKey = `${intent.tool}:${JSON.stringify(intent.parameters)}`;
      if (executedSet.has(dedupeKey)) {
        logger.warn("Duplicate tool call skipped", {
          tool: intent.tool,
          parameters: intent.parameters,
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
        const result = await toolRegistry.execute(intent.tool, intent.parameters);
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
