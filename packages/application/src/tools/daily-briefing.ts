import { z } from "zod";
import type {
  ClassificationRepository,
  InboundItemRepository,
  DeadlineRepository,
  ActionInstanceRepository,
  CalendarPort,
  SynthesisPort,
  Logger,
} from "@oneon/domain";
import type { ToolDefinition, ToolResult } from "./tool-registry.js";
import {
  generateDailyBriefing,
  type GenerateDailyBriefingDeps,
} from "../usecases/generate-daily-briefing.js";

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
  synthesizer: SynthesisPort;
  calendarPort?: CalendarPort;
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
        synthesizer: deps.synthesizer,
        calendarPort: deps.calendarPort,
        logger: deps.logger,
      };

      const result = await generateDailyBriefing(briefingDeps, {
        now: new Date(),
        timezone: input.timezone,
        userId: input.userId,
      });

      return {
        data: result.data,
        summary: result.summary,
      };
    },
  };
}
