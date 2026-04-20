import { z } from "zod";
import type { ActionLogRepository } from "@oneon/domain";
import type { ToolDefinition, ToolResult } from "./tool-registry.js";

// ── Input Schema ─────────────────────────────────────────────

export const listPendingActionsSchema = z.object({
  status: z
    .enum(["proposed", "approved", "executed", "rejected", "rolled_back"])
    .optional()
    .default("proposed"),
  actionType: z.string().optional(),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .default(20),
});

export type ListPendingActionsInput = z.infer<typeof listPendingActionsSchema>;

// ── Deps ─────────────────────────────────────────────────────

export interface ListPendingActionsDeps {
  actionLogRepo: ActionLogRepository;
}

// ── Factory ──────────────────────────────────────────────────

export function createListPendingActionsTool(
  deps: ListPendingActionsDeps
): ToolDefinition {
  const { actionLogRepo } = deps;

  return {
    name: "list_pending_actions",
    version: "1.0.0",
    description:
      "List actions awaiting approval or in a given status. Defaults to 'proposed' (pending approval).",
    inputSchema: listPendingActionsSchema,
    execute(validatedInput: unknown): ToolResult {
      const input = validatedInput as ListPendingActionsInput;

      const actions = actionLogRepo.findAll({
        status: input.status as Parameters<ActionLogRepository["findAll"]>[0]["status"],
        actionType: input.actionType as Parameters<ActionLogRepository["findAll"]>[0]["actionType"],
        limit: input.limit,
      });

      const count = actions.length;

      return {
        data: actions,
        summary:
          count === 0
            ? "Found 0 pending actions."
            : `Found ${count} pending action${count === 1 ? "" : "s"}.`,
      };
    },
  };
}
