import type { ConversationMessage, Logger } from "@oneon/domain";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { ModelTurn } from "../ai-boundary/gateway.js";
import {
  buildChatReplyRequest,
  type ChatPersonaProfile,
  type ToolCallRecord,
} from "../ai-boundary/requests/chat.js";
import { synthesisResponseSchema, type SynthesisResponse } from "../ai-boundary/purposes/schemas.js";

// ── Schema ───────────────────────────────────────────────────

export { synthesisResponseSchema, type SynthesisResponse };

// ── Constants ────────────────────────────────────────────────

export const DATA_WITHHELD_NOTE = "Some details weren't shared with the AI under your AI data settings.";

// ── Types ────────────────────────────────────────────────────

export interface SynthesizeResponseDeps {
  modelTurn: ModelTurn;
  logger: Logger;
}

export interface SynthesizeResponseInput {
  userMessage: string;
  toolCalls: ToolCallRecord[];
  history: ConversationMessage[];
  persona: ChatPersonaProfile | null;
  registry: ToolRegistry;
}

export type SynthesizeResponseResult =
  | { kind: "answered"; response: SynthesisResponse; dataWithheld: boolean }
  | { kind: "unavailable"; reason: string; dataWithheld: boolean };

// ── synthesizeResponse ───────────────────────────────────────

export async function synthesizeResponse(
  deps: SynthesizeResponseDeps,
  input: SynthesizeResponseInput,
): Promise<SynthesizeResponseResult> {
  const result = await deps.modelTurn.call(buildChatReplyRequest(input));
  // History is context, not answer data: only tool data withheld from records earns the note.
  const dataWithheld = result.withheld.some((w) => w.part.startsWith("record:"));
  if (result.kind === "answered") {
    return { kind: "answered", response: result.json as SynthesisResponse, dataWithheld };
  }
  deps.logger.warn("Chat reply unavailable", { kind: result.kind });
  return { kind: "unavailable", reason: result.kind, dataWithheld: dataWithheld || result.kind === "denied" };
}
