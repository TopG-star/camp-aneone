import { z } from "zod";

// ── GET /api/today (aggregated landing page data) ────────────

export const TodayResponseSchema = z.object({
  date: z.string(),
  briefingSummary: z.string(),
  calendar: z.object({
    status: z.enum(["connected", "not_connected", "error"]),
    events: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        start: z.string(),
        end: z.string(),
        location: z.string().nullable(),
        allDay: z.boolean(),
      }),
    ),
  }),
  urgentItems: z.array(
    z.object({
      id: z.string(),
      subject: z.string(),
      from: z.string(),
      source: z.string(),
      priority: z.number(),
      summary: z.string(),
    }),
  ),
  deadlines: z.array(
    z.object({
      id: z.string(),
      dueDate: z.string(),
      description: z.string(),
      confidence: z.number(),
      status: z.enum(["open", "done", "dismissed"]),
      inboundItemId: z.string(),
    }),
  ),
  pendingActions: z.object({
    count: z.number(),
    items: z.array(
      z.object({
        id: z.string(),
        actionType: z.string(),
        riskLevel: z.string(),
        resourceId: z.string(),
      }),
    ),
  }),
  counts: z.object({
    unreadNotifications: z.number(),
    totalInbox: z.number(),
    pendingActions: z.number(),
  }),
});

export type TodayResponse = z.infer<typeof TodayResponseSchema>;
