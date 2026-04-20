import { z } from "zod";
import type {
  ClassificationRepository,
  InboundItemRepository,
  Source,
} from "@oneon/domain";
import type { ToolDefinition, ToolResult } from "./tool-registry.js";

// ── Input Schema ─────────────────────────────────────────────

export const listFollowUpsSchema = z.object({
  overdue: z.boolean().optional(),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .default(20),
});

export type ListFollowUpsInput = z.infer<typeof listFollowUpsSchema>;

// ── Deps ─────────────────────────────────────────────────────

export interface ListFollowUpsDeps {
  classificationRepo: ClassificationRepository;
  inboundItemRepo: InboundItemRepository;
}

// ── Output Shape ─────────────────────────────────────────────

export interface FollowUpEntry {
  id: string;
  subject: string;
  from: string;
  source: Source;
  category: string;
  priority: number;
  summary: string;
  receivedAt: string;
}

// ── Factory ──────────────────────────────────────────────────

/**
 * Over-fetch multiplier: we request more classifications than `limit`
 * to account for the in-memory `followUpNeeded` filter discarding rows.
 */
const FETCH_MULTIPLIER = 5;

export function createListFollowUpsTool(
  deps: ListFollowUpsDeps
): ToolDefinition {
  const { classificationRepo, inboundItemRepo } = deps;

  return {
    name: "list_follow_ups",
    version: "1.0.0",
    description:
      "List items that need follow-up. Optionally filter to overdue items only.",
    inputSchema: listFollowUpsSchema,
    execute(validatedInput: unknown): ToolResult {
      const input = validatedInput as ListFollowUpsInput;

      const classifications = classificationRepo.findAll({
        limit: input.limit * FETCH_MULTIPLIER,
      });

      const items: FollowUpEntry[] = [];

      for (const cls of classifications) {
        if (items.length >= input.limit) break;
        if (!cls.followUpNeeded) continue;

        const item = inboundItemRepo.findById(cls.inboundItemId);
        if (!item) continue;

        items.push({
          id: item.id,
          subject: item.subject,
          from: item.from,
          source: item.source,
          category: cls.category,
          priority: cls.priority,
          summary: cls.summary,
          receivedAt: item.receivedAt,
        });
      }

      const count = items.length;

      return {
        data: items,
        summary:
          count === 0
            ? "Found 0 items needing follow-up."
            : `Found ${count} item${count === 1 ? "" : "s"} needing follow-up.`,
      };
    },
  };
}
