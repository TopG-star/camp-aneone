import type { ConversationMessage } from "@oneon/domain";

// ── Types ────────────────────────────────────────────────────

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

export interface BuildChatContextInput {
  stats: ChatContextStats;
  history: ConversationMessage[];
  toolDefinitions: Array<{ name: string; description: string }>;
  executedActions: ToolCallRecord[];
  now: Date;
  timezone: string;
}

// ── Context Builder ──────────────────────────────────────────

export function buildChatContext(input: BuildChatContextInput): string {
  const blocks: string[] = [
    buildSystemBlock(input.now, input.timezone),
    buildHistoryBlock(input.history),
    buildLocalContextBlock(input.stats),
    buildToolsBlock(input.toolDefinitions),
    buildActionsBlock(input.executedActions),
  ];

  return blocks.join("\n\n");
}

// ── Block Builders ───────────────────────────────────────────

function buildSystemBlock(now: Date, timezone: string): string {
  return [
    "=== SYSTEM ===",
    "You are Oneon, a personal AI assistant.",
    `Current time: ${now.toISOString()}`,
    `Timezone: ${timezone}`,
    "Respond to the user's request using the available tools. Return [{tool:\"none\",parameters:{}}] when no more tools are needed.",
  ].join("\n");
}

function buildHistoryBlock(history: ConversationMessage[]): string {
  const header = "=== HISTORY ===";
  if (history.length === 0) {
    return `${header}\nNo previous messages.`;
  }
  const lines = history.map((m) => `[${m.role}]: ${m.content}`);
  return `${header}\n${lines.join("\n")}`;
}

function buildLocalContextBlock(stats: ChatContextStats): string {
  return [
    "=== LOCAL CONTEXT ===",
    `Total inbox items: ${stats.totalInboxItems}`,
    `Unread urgent: ${stats.unreadUrgentCount}`,
    `Pending actions: ${stats.pendingActionsCount}`,
    `Upcoming deadlines: ${stats.upcomingDeadlinesCount}`,
    `Follow-ups needed: ${stats.followUpCount}`,
  ].join("\n");
}

function buildToolsBlock(
  toolDefinitions: Array<{ name: string; description: string }>
): string {
  const header = "=== TOOLS ===";
  if (toolDefinitions.length === 0) {
    return `${header}\nNo tools available.`;
  }
  const lines = toolDefinitions.map((t) => `- ${t.name}: ${t.description}`);
  return `${header}\n${lines.join("\n")}`;
}

function buildActionsBlock(executedActions: ToolCallRecord[]): string {
  const header = "=== ACTIONS ALREADY EXECUTED THIS TURN ===";
  if (executedActions.length === 0) {
    return `${header}\nNo actions executed yet.`;
  }
  const lines = executedActions.map((a) => {
    if (a.error) {
      return `[${a.id}] ${a.tool} → ERROR: ${a.error}`;
    }
    return `[${a.id}] ${a.tool} → ${a.result!.summary}`;
  });
  return `${header}\n${lines.join("\n")}`;
}
