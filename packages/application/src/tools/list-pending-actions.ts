import { z } from "zod";
import { LIFECYCLE_STATUSES, type ActionInstanceRepository } from "@oneon/domain";
import type { ToolDefinition, ToolResult } from "./tool-registry.js";
import type { ActionRegistry } from "../actions/registry.js";
import { describeInstance } from "../actions/orchestrator/shared.js";

export const listPendingActionsSchema = z.object({
  status: z.enum(LIFECYCLE_STATUSES).optional().default("awaiting_approval"),
  limit: z.number().int().min(1).max(50).optional().default(20),
  userId: z.string().trim().min(1).optional(),
});

export type ListPendingActionsInput = z.infer<typeof listPendingActionsSchema>;

export interface ListPendingActionsDeps {
  instanceRepo: ActionInstanceRepository;
  registry: ActionRegistry;
}

export function createListPendingActionsTool(deps: ListPendingActionsDeps): ToolDefinition {
  return {
    name: "list_pending_actions",
    version: "2.0.0",
    description: "List the user's actions in a status. Defaults to actions awaiting approval.",
    inputSchema: listPendingActionsSchema,
    output: {
      fields: { id: { class: "D1" }, actionType: { class: "D1" }, label: { class: "D1" }, status: { class: "D1" }, createdAt: { class: "D1" }, description: { class: "D2", freeText: true } },
      summaryClass: "D1",
    },
    execute(validatedInput: unknown): ToolResult {
      const input = validatedInput as z.infer<typeof listPendingActionsSchema>;
      if (!input.userId) return { data: [], summary: "Found 0 actions." };
      const actions = deps.instanceRepo.list(input.userId, { statuses: [input.status], limit: input.limit }).map((i) => {
        const def = deps.registry.get(i.actionType);
        return { id: i.id, actionType: i.actionType, label: def.label, status: i.status, description: describeInstance(def, i), createdAt: i.createdAt };
      });
      const noun = input.status === "awaiting_approval" ? "awaiting approval" : input.status;
      return { data: actions, summary: `Found ${actions.length} action${actions.length === 1 ? "" : "s"} ${noun}.` };
    },
  };
}
