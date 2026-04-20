import { z } from "zod";
import type {
  ClassificationRepository,
  InboundItemRepository,
  Source,
} from "@oneon/domain";
import type { ToolDefinition, ToolResult } from "./tool-registry.js";

// ── Input Schema ─────────────────────────────────────────────

export const listInboxSchema = z.object({
  maxPriority: z
    .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)])
    .optional(),
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

export type ListInboxInput = z.infer<typeof listInboxSchema>;

// ── Deps ─────────────────────────────────────────────────────

export interface ListInboxDeps {
  inboundItemRepo: InboundItemRepository;
  classificationRepo: ClassificationRepository;
}

// ── Output Shape ─────────────────────────────────────────────

export interface InboxEntry {
  id: string;
  subject: string;
  from: string;
  source: Source;
  receivedAt: string;
  category: string | null;
  priority: number | null;
  summary: string | null;
}

// ── Factory ──────────────────────────────────────────────────

export function createListInboxTool(deps: ListInboxDeps): ToolDefinition {
  const { inboundItemRepo, classificationRepo } = deps;

  return {
    name: "list_inbox",
    version: "1.0.0",
    description:
      "List recent inbox items by source, priority threshold, or date. Returns items enriched with classification data when available.",
    inputSchema: listInboxSchema,
    execute(validatedInput: unknown): ToolResult {
      const input = validatedInput as ListInboxInput;

      const items = inboundItemRepo.findAll({
        source: input.source as Source | undefined,
        since: input.since?.toISOString(),
        limit: input.limit,
      });

      const entries: InboxEntry[] = [];

      for (const item of items) {
        const cls = classificationRepo.findByInboundItemId(item.id);

        // Post-query priority filter: skip items that exceed maxPriority
        // Unclassified items are always included (unknown priority = don't exclude)
        if (input.maxPriority !== undefined && cls && cls.priority > input.maxPriority) {
          continue;
        }

        entries.push({
          id: item.id,
          subject: item.subject,
          from: item.from,
          source: item.source,
          receivedAt: item.receivedAt,
          category: cls?.category ?? null,
          priority: cls?.priority ?? null,
          summary: cls?.summary ?? null,
        });
      }

      const count = entries.length;

      return {
        data: entries,
        summary:
          count === 0
            ? "Found 0 inbox items."
            : `Found ${count} inbox item${count === 1 ? "" : "s"}.`,
      };
    },
  };
}
