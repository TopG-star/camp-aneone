import { z } from "zod";
import type {
  ClassificationRepository,
  InboundItemRepository,
  DeadlineRepository,
  ActionLogRepository,
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
});

export type DailyBriefingInput = z.infer<typeof dailyBriefingSchema>;

// ── Deps ─────────────────────────────────────────────────────

export interface DailyBriefingDeps {
  classificationRepo: ClassificationRepository;
  inboundItemRepo: InboundItemRepository;
  deadlineRepo: DeadlineRepository;
  actionLogRepo: ActionLogRepository;
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
        actionLogRepo: deps.actionLogRepo,
        synthesizer: deps.synthesizer,
        calendarPort: deps.calendarPort,
        logger: deps.logger,
      };

      const result = await generateDailyBriefing(briefingDeps, {
        now: new Date(),
        timezone: input.timezone,
      });

      return {
        data: result.data,
        summary: result.summary,
      };
    },
  };
}
