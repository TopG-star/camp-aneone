import { z } from "zod";
import { OffsetPaginationQuerySchema, OffsetPaginationMetaSchema } from "./pagination.contract.js";

// ── Source & Category enums ──────────────────────────────────

const SourceEnum = z.enum(["gmail", "outlook", "teams", "github"]);
const CategoryEnum = z.enum([
  "urgent",
  "work",
  "personal",
  "newsletter",
  "transactional",
  "spam",
  "actionable",
]);
const PriorityEnum = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);

// ── Inbox Query (GET /api/inbox) ─────────────────────────────

export const InboxQuerySchema = OffsetPaginationQuerySchema.extend({
  source: SourceEnum.optional(),
  category: CategoryEnum.optional(),
  maxPriority: z.coerce.number().int().min(1).max(5).optional(),
  since: z.string().datetime().optional(),
});

export type InboxQuery = z.infer<typeof InboxQuerySchema>;

// ── Inbox Item (enriched with classification) ────────────────

export const InboxItemResponseSchema = z.object({
  id: z.string(),
  source: SourceEnum,
  externalId: z.string(),
  from: z.string(),
  subject: z.string(),
  bodyPreview: z.string(),
  receivedAt: z.string(),
  threadId: z.string().nullable(),
  labels: z.string(),
  createdAt: z.string(),
  classification: z
    .object({
      id: z.string(),
      category: CategoryEnum,
      priority: PriorityEnum,
      summary: z.string(),
      actionItems: z.string(),
      followUpNeeded: z.boolean(),
    })
    .nullable(),
});

export type InboxItemResponse = z.infer<typeof InboxItemResponseSchema>;

// ── Inbox List Response ──────────────────────────────────────

export const InboxListResponseSchema = z.object({
  items: z.array(InboxItemResponseSchema),
  pagination: OffsetPaginationMetaSchema,
});

export type InboxListResponse = z.infer<typeof InboxListResponseSchema>;

// ── Inbox Detail (single item enriched with classification + deadlines + actions)

export const InboxDetailResponseSchema = InboxItemResponseSchema.extend({
  deadlines: z.array(
    z.object({
      id: z.string(),
      dueDate: z.string(),
      description: z.string(),
      confidence: z.number(),
      status: z.enum(["open", "done", "dismissed"]),
    }),
  ),
  actions: z.array(
    z.object({
      id: z.string(),
      actionType: z.string(),
      riskLevel: z.enum(["auto", "approval_required"]),
      status: z.enum([
        "proposed",
        "approved",
        "executed",
        "rejected",
        "rolled_back",
      ]),
      createdAt: z.string(),
    }),
  ),
});

export type InboxDetailResponse = z.infer<typeof InboxDetailResponseSchema>;
