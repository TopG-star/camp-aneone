import { z } from "zod";

// ── Deadline Status ──────────────────────────────────────────

const DeadlineStatusEnum = z.enum(["open", "done", "dismissed"]);

// ── GET /api/deadlines ───────────────────────────────────────

export const DeadlinesQuerySchema = z.object({
  status: DeadlineStatusEnum.optional(),
  range: z.coerce.number().int().min(1).max(365).default(30),
});

export type DeadlinesQuery = z.infer<typeof DeadlinesQuerySchema>;

// ── Deadline Item Response ───────────────────────────────────

export const DeadlineItemResponseSchema = z.object({
  id: z.string(),
  inboundItemId: z.string(),
  dueDate: z.string(),
  description: z.string(),
  confidence: z.number(),
  status: DeadlineStatusEnum,
  createdAt: z.string(),
  userId: z.string(),
  // Enriched fields
  itemSubject: z.string().nullable(),
  itemSource: z.string().nullable(),
});

export type DeadlineItemResponse = z.infer<typeof DeadlineItemResponseSchema>;

// ── Deadlines List Response ──────────────────────────────────

export const DeadlinesListResponseSchema = z.object({
  deadlines: z.array(DeadlineItemResponseSchema),
  counts: z.object({
    total: z.number(),
    open: z.number(),
    overdue: z.number(),
  }),
});

export type DeadlinesListResponse = z.infer<typeof DeadlinesListResponseSchema>;
