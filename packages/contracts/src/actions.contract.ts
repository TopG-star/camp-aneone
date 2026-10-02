import { z } from "zod";
import { OffsetPaginationQuerySchema, OffsetPaginationMetaSchema } from "./pagination.contract.js";

// ── Action Status enum ───────────────────────────────────────

/** @deprecated Removed in Task 18. */
const ActionStatusEnum = z.enum([
  "proposed",
  "approved",
  "executed",
  "rejected",
  "rolled_back",
]);

/** @deprecated Removed in Task 18. */
const ActionExecutionStatusEnum = z.enum([
  "not_started",
  "running",
  "succeeded",
  "failed",
]);

// ── Actions Query (GET /api/actions) ─────────────────────────

/** @deprecated Removed in Task 18. */
export const ActionsQuerySchema = OffsetPaginationQuerySchema.extend({
  status: ActionStatusEnum.optional(),
});

/** @deprecated Removed in Task 18. */
export type ActionsQuery = z.infer<typeof ActionsQuerySchema>;

// ── Action Item Response ─────────────────────────────────────

/** @deprecated Removed in Task 18. */
export const ActionItemResponseSchema = z.object({
  id: z.string(),
  resourceId: z.string(),
  actionType: z.string(),
  riskLevel: z.enum(["auto", "approval_required"]),
  status: ActionStatusEnum,
  executionStatus: ActionExecutionStatusEnum,
  payloadJson: z.string(),
  resultJson: z.string().nullable(),
  errorJson: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // Enriched: source item metadata for human-readable action context
  itemFrom: z.string().nullable(),
  itemSource: z.string().nullable(),
  // Enriched: the source item's subject (if available)
  itemSubject: z.string().nullable(),
});

/** @deprecated Removed in Task 18. */
export type ActionItemResponse = z.infer<typeof ActionItemResponseSchema>;

// ── Single Action Response (GET /api/actions/:id) ───────────

/** @deprecated Removed in Task 18. */
export const ActionResponseSchema = ActionItemResponseSchema;

/** @deprecated Removed in Task 18. */
export type ActionResponse = z.infer<typeof ActionResponseSchema>;

// ── Actions List Response ────────────────────────────────────

/** @deprecated Removed in Task 18. */
export const ActionsListResponseSchema = z.object({
  actions: z.array(ActionItemResponseSchema),
  pagination: OffsetPaginationMetaSchema,
});

/** @deprecated Removed in Task 18. */
export type ActionsListResponse = z.infer<typeof ActionsListResponseSchema>;

// ── Action Spec framework (spec §11, §13) ────────────────────

export const LIFECYCLE_STATUS_VALUES = [
  "proposed", "validating", "awaiting_approval", "approved", "executing", "verifying",
  "completed", "partially_completed", "rejected", "expired", "cancelled", "failed",
  "rolling_back", "rolled_back", "rollback_failed",
] as const;
export const ActionStatusValueSchema = z.enum(LIFECYCLE_STATUS_VALUES);
export type ActionStatusValue = z.infer<typeof ActionStatusValueSchema>;

/** Spec §13.1: each status in exactly one group; the group sets the colour. */
export const STATUS_GROUPS = {
  needs_you: ["awaiting_approval"],
  in_progress: ["proposed", "validating", "approved", "executing", "verifying", "rolling_back"],
  done: ["completed", "rolled_back"],
  problem: ["failed", "partially_completed", "rollback_failed"],
  closed: ["rejected", "expired", "cancelled"],
} as const satisfies Record<string, readonly ActionStatusValue[]>;
export type StatusGroup = keyof typeof STATUS_GROUPS;
export const STATUS_GROUP_VALUES = Object.keys(STATUS_GROUPS) as StatusGroup[];

export function groupOf(status: ActionStatusValue): StatusGroup {
  return STATUS_GROUP_VALUES.find((g) => (STATUS_GROUPS[g] as readonly string[]).includes(status))!;
}

export const ActionViewQuerySchema = OffsetPaginationQuerySchema.extend({
  group: z.enum(["needs_you", "in_progress", "done", "problem", "closed"]).optional(),
  status: ActionStatusValueSchema.optional(),
});

const EvidenceItemSchema = z.object({ kind: z.string(), source: z.string(), asOf: z.string(), data: z.record(z.unknown()) });
const CheckResultSchema = z.object({ id: z.string(), passed: z.boolean(), expected: z.unknown().optional(), actual: z.unknown().optional() });
const OperationSchema = z.enum(["approve", "reject", "cancel", "undo", "retry"]);

export const ActionEventViewSchema = z.object({
  seq: z.number(),
  fromStatus: ActionStatusValueSchema.nullable(),
  toStatus: ActionStatusValueSchema,
  actor: z.object({ kind: z.enum(["user", "policy", "system", "sweeper"]), userId: z.string().optional() }),
  data: z.record(z.unknown()),
  createdAt: z.string(),
});

export const ActionViewSchema = z.object({
  id: z.string(),
  actionType: z.string(),
  label: z.string(),
  status: ActionStatusValueSchema,
  group: z.enum(["needs_you", "in_progress", "done", "problem", "closed"]),
  risk: z.string(),
  origin: z.object({ kind: z.enum(["rule", "chat", "user", "schedule"]), label: z.string(), excerpt: z.string().nullable() }),
  description: z.string(),
  evidence: z.array(EvidenceItemSchema),
  decision: z.object({ outcome: z.enum(["refuse", "needs_approval", "auto"]), reasons: z.array(z.object({ code: z.string(), text: z.string() })) }).nullable(),
  checks: z.array(CheckResultSchema),
  undo: z.object({ rollbackClass: z.enum(["reversible", "conditional", "irreversible"]), text: z.string(), warning: z.string().nullable() }),
  error: z.object({ code: z.string(), message: z.string(), stage: z.string() }).nullable(),
  allowedOperations: z.array(OperationSchema),
  retryOf: z.string().nullable(),
  attemptNumber: z.number(),
  resourceRef: z.string().nullable(),
  verifyingSince: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  timeline: z.array(ActionEventViewSchema),
});
export type ActionView = z.infer<typeof ActionViewSchema>;

export const ActionViewListResponseSchema = z.object({ actions: z.array(ActionViewSchema), pagination: OffsetPaginationMetaSchema });
export type ActionViewListResponse = z.infer<typeof ActionViewListResponseSchema>;

export const LEGACY_BANNER = "MVP1 actions changed status only; nothing was executed.";
export const LegacyActionViewSchema = z.object({
  id: z.string(),
  actionType: z.string(),
  status: z.string(),
  payload: z.record(z.unknown()),
  createdAt: z.string(),
});
export const LegacyActionListResponseSchema = z.object({
  actions: z.array(LegacyActionViewSchema),
  pagination: OffsetPaginationMetaSchema,
  banner: z.literal(LEGACY_BANNER),
});
export type LegacyActionListResponse = z.infer<typeof LegacyActionListResponseSchema>;

export const ActionDefinitionViewSchema = z.object({
  type: z.string(),
  label: z.string(),
  description: z.string(),
  available: z.boolean(),
  unavailableReason: z.string().nullable(),
  rollbackClass: z.enum(["reversible", "conditional", "irreversible"]),
  risk: z.object({ floor: z.string(), effective: z.string() }),
  approval: z.object({ mode: z.enum(["auto", "above_threshold", "always"]), options: z.array(z.object({ mode: z.enum(["auto", "above_threshold", "always"]), label: z.string() })) }),
  expiryHours: z.number(),
  enabled: z.boolean(),
  disableWarning: z.string().nullable(),
  flags: z.object({ clamped: z.array(z.string()), rejected: z.string().nullable() }),
  lastChange: z.object({ changedBy: z.string(), changedAt: z.string() }).nullable(),
});
export type ActionDefinitionView = z.infer<typeof ActionDefinitionViewSchema>;
export const ActionDefinitionsResponseSchema = z.object({ definitions: z.array(ActionDefinitionViewSchema) });
export type ActionDefinitionsResponse = z.infer<typeof ActionDefinitionsResponseSchema>;

export const ActionConfigWriteSchema = z
  .object({ enabled: z.boolean().optional(), approvalMode: z.enum(["auto", "above_threshold", "always"]).optional() })
  .strict();
export type ActionConfigWrite = z.infer<typeof ActionConfigWriteSchema>;
