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

// ── POST /api/cycle/run-now ──────────────────────────────────

export const RunNowResponseSchema = z.object({
  triggered: z.boolean(),
  reason: z.string().optional(),
});

export type RunNowResponse = z.infer<typeof RunNowResponseSchema>;
