import { z } from "zod";
import { OffsetPaginationQuerySchema, OffsetPaginationMetaSchema } from "./pagination.contract.js";

// ── Action Status enum ───────────────────────────────────────

const ActionStatusEnum = z.enum([
  "proposed",
  "approved",
  "executed",
  "rejected",
  "rolled_back",
]);

// ── Actions Query (GET /api/actions) ─────────────────────────

export const ActionsQuerySchema = OffsetPaginationQuerySchema.extend({
  status: ActionStatusEnum.optional(),
});

export type ActionsQuery = z.infer<typeof ActionsQuerySchema>;

// ── Action Item Response ─────────────────────────────────────

export const ActionItemResponseSchema = z.object({
  id: z.string(),
  resourceId: z.string(),
  actionType: z.string(),
  riskLevel: z.enum(["auto", "approval_required"]),
  status: ActionStatusEnum,
  payloadJson: z.string(),
  resultJson: z.string().nullable(),
  errorJson: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // Enriched: the source item's subject (if available)
  itemSubject: z.string().nullable(),
});

export type ActionItemResponse = z.infer<typeof ActionItemResponseSchema>;

// ── Actions List Response ────────────────────────────────────

export const ActionsListResponseSchema = z.object({
  actions: z.array(ActionItemResponseSchema),
  pagination: OffsetPaginationMetaSchema,
});

export type ActionsListResponse = z.infer<typeof ActionsListResponseSchema>;
