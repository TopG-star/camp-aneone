import type { CommunicationStyle, ConversationMessage, SalutationMode } from "@oneon/domain";
import type { ToolRegistry } from "../../tools/tool-registry.js";
import { toolResultToRecord } from "../../tools/output-schema.js";
import type { HistoryTurn, ModelRequest, PromptPart, ToolDescriptor } from "../types.js";

export interface ChatContextStats {
  totalInboxItems: number;
  unreadUrgentCount: number;
  pendingActionsCount: number;
  upcomingDeadlinesCount: number;
  followUpCount: number;
}

export interface ToolCallRecord {
  id: string;
  round: number;
  tool: string;
  parameters: Record<string, unknown>;
  result: { data: unknown; summary: string } | null;
  error: string | null;
  durationMs: number;
  executedAt: string; // ISO-8601
}

export interface ChatPersonaProfile {
  preferredName: string | null;
  nickname: string | null;
  salutationMode: SalutationMode;
  communicationStyle: CommunicationStyle;
}

export function resolvePreferredSalutation(persona: ChatPersonaProfile): string {
  if (persona.salutationMode === "sir") return "Sir";
  if (persona.salutationMode === "sir_with_name") return persona.preferredName ? `Sir ${persona.preferredName}` : "Sir";
  return persona.nickname ?? persona.preferredName ?? "Sir";
}

export function historyTurns(history: ConversationMessage[]): HistoryTurn[] {
  return history
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role as "user" | "assistant", text: m.content }));
}

function personaPart(persona: ChatPersonaProfile | null): PromptPart[] {
  if (!persona) return [];
  return [
    {
      kind: "record",
      source: "persona",
      rows: [
        {
          fields: [
            { name: "salutation", class: "D1", value: resolvePreferredSalutation(persona) },
            { name: "communicationStyle", class: "D1", value: persona.communicationStyle },
          ],
        },
      ],
    },
  ];
}

function toolParts(toolCalls: ToolCallRecord[], registry: ToolRegistry): PromptPart[] {
  return toolCalls.map((call): PromptPart => {
    const tool = registry.get(call.tool);
    if (call.result && tool) return toolResultToRecord(call.tool, tool.output, call.result);
    return {
      kind: "record",
      source: "tool_error",
      rows: [
        {
          fields: [
            { name: "tool", class: "D0", value: call.tool },
            { name: "error", class: "D1", value: call.error ?? "Tool unavailable" },
          ],
        },
      ],
    };
  });
}

export function buildIntentRequest(input: {
  userMessage: string;
  history: ConversationMessage[];
  toolDefinitions: ToolDescriptor[];
  stats: ChatContextStats;
  now: Date;
  timezone: string;
  persona: ChatPersonaProfile | null;
  toolCalls: ToolCallRecord[];
  registry: ToolRegistry;
}): ModelRequest {
  const s = input.stats;
  return {
    purpose: "intent_extraction",
    output: "json",
    parts: [
      { kind: "tool_catalog", tools: input.toolDefinitions },
      {
        kind: "record",
        source: "context",
        rows: [
          {
            fields: [
              { name: "currentTime", class: "D1", value: input.now.toISOString() },
              { name: "timezone", class: "D1", value: input.timezone },
              { name: "totalInboxItems", class: "D1", value: s.totalInboxItems },
              { name: "unreadUrgentCount", class: "D1", value: s.unreadUrgentCount },
              { name: "pendingActionsCount", class: "D1", value: s.pendingActionsCount },
              { name: "upcomingDeadlinesCount", class: "D1", value: s.upcomingDeadlinesCount },
              { name: "followUpCount", class: "D1", value: s.followUpCount },
            ],
          },
        ],
      },
      ...personaPart(input.persona),
      ...(input.history.length > 0 ? [{ kind: "history" as const, turns: historyTurns(input.history) }] : []),
      { kind: "user_message", text: input.userMessage },
      ...toolParts(input.toolCalls, input.registry),
    ],
  };
}

export function buildChatReplyRequest(input: {
  userMessage: string;
  history: ConversationMessage[];
  persona: ChatPersonaProfile | null;
  toolCalls: ToolCallRecord[];
  registry: ToolRegistry;
}): ModelRequest {
  return {
    purpose: "chat_reply",
    output: "json",
    parts: [
      ...personaPart(input.persona),
      ...(input.history.length > 0 ? [{ kind: "history" as const, turns: historyTurns(input.history) }] : []),
      { kind: "user_message", text: input.userMessage },
      ...toolParts(input.toolCalls.filter((c) => c.result !== null || c.error !== null), input.registry),
    ],
  };
}
