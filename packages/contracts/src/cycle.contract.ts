import { z } from "zod";

// ── GET /api/cycle-status ────────────────────────────────────

export const CycleStatusResponseSchema = z.object({
  running: z.boolean(),
  lastCycleAt: z.string().nullable(),
  lastError: z.string().nullable(),
  consecutiveErrors: z.number(),
  enabled: z.boolean(),
});

export type CycleStatusResponse = z.infer<typeof CycleStatusResponseSchema>;

// ── GET /api/cycle/errors ──────────────────────────────────

export const CycleErrorItemSchema = z.object({
  id: z.string(),
  occurredAt: z.string(),
  component: z.string(),
  stage: z.string(),
  scope: z.enum(["global", "action"]),
  userId: z.string().nullable(),
  message: z.string(),
  actionId: z.string().nullable(),
});

export const CycleErrorsResponseSchema = z.object({
  errors: z.array(CycleErrorItemSchema),
});

export type CycleErrorItem = z.infer<typeof CycleErrorItemSchema>;
export type CycleErrorsResponse = z.infer<typeof CycleErrorsResponseSchema>;

// ── POST /api/cycle/run-now ──────────────────────────────────

export const RunNowResponseSchema = z.object({
  triggered: z.boolean(),
  reason: z.string().optional(),
});

export type RunNowResponse = z.infer<typeof RunNowResponseSchema>;
