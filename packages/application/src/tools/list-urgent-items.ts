import { z } from "zod";
import type {
  ClassificationRepository,
  InboundItemRepository,
  Source,
} from "@oneon/domain";
import type { ToolDefinition, ToolResult } from "./tool-registry.js";

// ── Input Schema ─────────────────────────────────────────────

export const listUrgentItemsSchema = z.object({
  maxPriority: z
    .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)])
    .optional()
    .default(2),
  source: z
    .enum(["gmail", "outlook", "teams", "github"])
    .optional(),
  since: z.coerce
    .date()
    .optional()
    .refine((d) => d === undefined || !isNaN(d.getTime()), {
      message: "Invalid date",
    }),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .default(20),
});

export type ListUrgentItemsInput = z.infer<typeof listUrgentItemsSchema>;

// ── Deps (repos only — no coupling to registry) ─────────────

export interface ListUrgentItemsDeps {
  classificationRepo: ClassificationRepository;
  inboundItemRepo: InboundItemRepository;
}

// ── Output Shape ─────────────────────────────────────────────

export interface UrgentItemEntry {
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

export function createListUrgentItemsTool(
  deps: ListUrgentItemsDeps
): ToolDefinition {
  const { classificationRepo, inboundItemRepo } = deps;

  return {
    name: "list_urgent_items",
    version: "1.0.0",
    description:
      "List urgent and high-priority inbox items. Returns items with priority ≤ maxPriority (1 = most urgent, 5 = least).",
    inputSchema: listUrgentItemsSchema,
    execute(validatedInput: unknown): ToolResult {
      const input = validatedInput as ListUrgentItemsInput;

      const classifications = classificationRepo.findAll({
        minPriority: input.maxPriority,
        limit: input.limit,
      });

      const items: UrgentItemEntry[] = [];

      for (const cls of classifications) {
        const item = inboundItemRepo.findById(cls.inboundItemId);
        if (!item) continue;

        // Post-query source filter (repo doesn't support cross-table source filtering)
        if (input.source && item.source !== input.source) continue;

        // Post-query since filter
        if (input.since && new Date(item.receivedAt) < input.since) continue;

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

      return {
        data: items,
        summary:
          items.length === 0
            ? "Found 0 urgent items."
            : `Found ${items.length} urgent item${items.length === 1 ? "" : "s"} (priority ≤ ${input.maxPriority}).`,
      };
    },
  };
}
