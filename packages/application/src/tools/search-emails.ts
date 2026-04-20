import { z } from "zod";
import type {
  ClassificationRepository,
  InboundItemRepository,
  Source,
} from "@oneon/domain";
import type { ToolDefinition, ToolResult } from "./tool-registry.js";

// ── Input Schema ─────────────────────────────────────────────

export const searchEmailsSchema = z.object({
  query: z.string().optional(),
  source: z
    .enum(["gmail", "outlook", "teams", "github"])
    .optional(),
  category: z
    .enum(["urgent", "work", "personal", "newsletter", "transactional", "spam"])
    .optional(),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .default(20),
});

export type SearchEmailsInput = z.infer<typeof searchEmailsSchema>;

// ── Deps ─────────────────────────────────────────────────────

export interface SearchEmailsDeps {
  inboundItemRepo: InboundItemRepository;
  classificationRepo: ClassificationRepository;
}

// ── Output Shape ─────────────────────────────────────────────

export interface SearchEmailEntry {
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

export function createSearchEmailsTool(
  deps: SearchEmailsDeps
): ToolDefinition {
  const { inboundItemRepo, classificationRepo } = deps;

  return {
    name: "search_emails",
    version: "1.0.0",
    description:
      "Search emails by query text, source, or category. Text search matches subject, body preview, and sender.",
    inputSchema: searchEmailsSchema,
    execute(validatedInput: unknown): ToolResult {
      const input = validatedInput as SearchEmailsInput;

      // Use search when query provided, findAll otherwise
      const rawItems = input.query
        ? inboundItemRepo.search({
            query: input.query,
            source: input.source as Source | undefined,
            limit: input.limit,
          })
        : inboundItemRepo.findAll({
            source: input.source as Source | undefined,
            limit: input.limit,
          });

      const entries: SearchEmailEntry[] = [];

      for (const item of rawItems) {
        const cls = classificationRepo.findByInboundItemId(item.id);

        // Post-query category filter
        if (input.category) {
          if (!cls || cls.category !== input.category) continue;
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

      if (input.query) {
        return {
          data: entries,
          summary:
            count === 0
              ? `Found 0 results for "${input.query}".`
              : `Found ${count} result${count === 1 ? "" : "s"} for "${input.query}".`,
        };
      }

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
