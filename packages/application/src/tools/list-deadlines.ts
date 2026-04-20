import { z } from "zod";
import type { Deadline, DeadlineRepository } from "@oneon/domain";
import type { ToolDefinition, ToolResult } from "./tool-registry.js";

// ── Input Schema ─────────────────────────────────────────────

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export const listDeadlinesSchema = z.object({
  from: z.coerce
    .date()
    .optional()
    .default(() => new Date()),
  to: z.coerce
    .date()
    .optional()
    .default(() => new Date(Date.now() + SEVEN_DAYS_MS)),
  status: z
    .enum(["open", "done", "dismissed"])
    .optional(),
});

export type ListDeadlinesInput = z.infer<typeof listDeadlinesSchema>;

// ── Deps ─────────────────────────────────────────────────────

export interface ListDeadlinesDeps {
  deadlineRepo: DeadlineRepository;
}

// ── Factory ──────────────────────────────────────────────────

export function createListDeadlinesTool(
  deps: ListDeadlinesDeps
): ToolDefinition {
  const { deadlineRepo } = deps;

  return {
    name: "list_deadlines",
    version: "1.0.0",
    description:
      "List deadlines within a date range. Defaults to the next 7 days. Optionally filter by status (open, done, dismissed).",
    inputSchema: listDeadlinesSchema,
    execute(validatedInput: unknown): ToolResult {
      const input = validatedInput as ListDeadlinesInput;

      const deadlines: Deadline[] = deadlineRepo.findByDateRange(
        input.from.toISOString(),
        input.to.toISOString(),
        input.status,
      );

      const count = deadlines.length;

      return {
        data: deadlines,
        summary:
          count === 0
            ? "Found 0 deadlines in the specified range."
            : `Found ${count} deadline${count === 1 ? "" : "s"} between ${input.from.toISOString().slice(0, 10)} and ${input.to.toISOString().slice(0, 10)}.`,
      };
    },
  };
}
