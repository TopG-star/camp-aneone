import { z } from "zod";
import type {
  ClassificationRepository,
  InboundItemRepository,
  DeadlineRepository,
  ActionInstanceRepository,
  CalendarPort,
  Logger,
} from "@oneon/domain";
import type { ModelGateway } from "../ai-boundary/gateway.js";
import type { ToolDefinition, ToolResult } from "./tool-registry.js";
import {
  generateDailyBriefing,
  type GenerateDailyBriefingDeps,
} from "../usecases/generate-daily-briefing.js";

export const BRIEFING_WITHHELD_NOTE = "The AI summary was withheld under your AI data settings.";

// ── Input Schema ─────────────────────────────────────────────

export const dailyBriefingSchema = z.object({
  timezone: z.string().optional().default("UTC"),
  userId: z.string().trim().min(1).optional(),
});

export type DailyBriefingInput = z.infer<typeof dailyBriefingSchema>;

// ── Deps ─────────────────────────────────────────────────────

export interface DailyBriefingDeps {
  classificationRepo: ClassificationRepository;
  inboundItemRepo: InboundItemRepository;
  deadlineRepo: DeadlineRepository;
  instanceRepo: ActionInstanceRepository;
  modelGateway: ModelGateway | null;
  calendarPort?: CalendarPort;
  resolveCalendarPort?: (userId: string) => CalendarPort | null;
  logger: Logger;
}

// ── Factory ──────────────────────────────────────────────────

export function createDailyBriefingTool(deps: DailyBriefingDeps): ToolDefinition {
  return {
    name: "daily_briefing",
    version: "1.0.0",
    description:
      "Generate today's morning briefing: calendar events, urgent items, upcoming deadlines, and pending actions awaiting approval.",
    inputSchema: dailyBriefingSchema,
    output: {
      fields: { date: { class: "D1" }, pendingActions: { class: "D1" }, urgentItems: { class: "D2" }, deadlines: { class: "D2" }, calendar: { class: "D2" } },
      summaryClass: "D2",
    },
    async execute(validatedInput: unknown): Promise<ToolResult> {
      const input = validatedInput as DailyBriefingInput;

      const briefingDeps: GenerateDailyBriefingDeps = {
        classificationRepo: deps.classificationRepo,
        inboundItemRepo: deps.inboundItemRepo,
        deadlineRepo: deps.deadlineRepo,
        listPendingActions: () =>
          input.userId
            ? deps.instanceRepo.list(input.userId, { statuses: ["awaiting_approval"], limit: 20 }).map((i) => ({
                actionType: i.actionType,
                resourceId: i.resourceRef ?? i.id,
                riskLevel: String((i.decision as { risk?: string } | null)?.risk ?? "L1"),
              }))
            : [],
        modelGateway: deps.modelGateway,
        calendarPort: deps.calendarPort,
        resolveCalendarPort: deps.resolveCalendarPort,
        logger: deps.logger,
      };

      const result = await generateDailyBriefing(briefingDeps, {
        now: new Date(),
        timezone: input.timezone,
        userId: input.userId,
      });

      return {
        data: result.data,
        summary: result.aiWithheld ? `${result.summary}

${BRIEFING_WITHHELD_NOTE}` : result.summary,
      };
    },
  };
}
