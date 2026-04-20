import { z } from "zod";

// ── GET /api/status (integration connection statuses) ────────

export const IntegrationStatusSchema = z.object({
  name: z.string(),
  connected: z.boolean(),
  detail: z.string().optional(),
});

export type IntegrationStatus = z.infer<typeof IntegrationStatusSchema>;

export const StatusResponseSchema = z.object({
  integrations: z.array(IntegrationStatusSchema),
  uptime: z.number(),
});

export type StatusResponse = z.infer<typeof StatusResponseSchema>;
