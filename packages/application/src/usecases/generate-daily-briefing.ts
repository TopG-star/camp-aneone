import type {
  ClassificationRepository,
  InboundItemRepository,
  DeadlineRepository,
  CalendarPort,
  CalendarEvent,
  SynthesisPort,
  Logger,
  Deadline,
} from "@oneon/domain";

// ── Constants ────────────────────────────────────────────────

const MAX_URGENT_PRIORITY = 2;
const MAX_URGENT_ITEMS = 20;

export const BRIEFING_PROMPT_VERSION = "1.0";

// ── Types ────────────────────────────────────────────────────

export interface PendingActionSummary {
  actionType: string;
  resourceId: string;
  riskLevel: string;
}

export interface UrgentItemSummary {
  id: string;
  subject: string;
  from: string;
  source: string;
  category: string;
  priority: number;
  summary: string;
}

export type CalendarStatus = "connected" | "not_connected" | "error";

export interface BriefingData {
  date: string;
  urgentItems: UrgentItemSummary[];
  deadlines: Deadline[];
  pendingActions: PendingActionSummary[];
  calendar: {
    status: CalendarStatus;
    events: CalendarEvent[];
  };
}

export interface GenerateDailyBriefingDeps {
  classificationRepo: ClassificationRepository;
  inboundItemRepo: InboundItemRepository;
  deadlineRepo: DeadlineRepository;
  listPendingActions(): PendingActionSummary[];
  synthesizer: SynthesisPort;
  calendarPort?: CalendarPort;
  logger: Logger;
}

export interface GenerateDailyBriefingInput {
  now: Date;
  timezone: string;
  /** Whose briefing this is. Without it, user-owned sections are empty rather than unscoped. */
  userId?: string;
}

export interface GenerateDailyBriefingResult {
  data: BriefingData;
  summary: string;
}

// ── Helpers ──────────────────────────────────────────────────

/**
 * Returns the local date string (YYYY-MM-DD) for the given instant
 * in the given IANA timezone.
 */
function getLocalDateString(now: Date, timezone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(now); // "YYYY-MM-DD" in en-CA locale
}

/**
 * Returns the start-of-day (00:00:00) in the given timezone as a UTC ISO string.
 */
function startOfDayUTC(dateStr: string, timezone: string): string {
  const [year, month, day] = dateStr.split("-").map((part) => Number(part));

  if (timezone === "UTC") {
    return new Date(Date.UTC(year, month - 1, day, 0, 0, 0)).toISOString();
  }

  // Start with UTC midnight guess and iteratively converge on local midnight in target timezone.
  let guessMs = Date.UTC(year, month - 1, day, 0, 0, 0);
  const targetLocalMs = Date.UTC(year, month - 1, day, 0, 0, 0);

  for (let i = 0; i < 6; i++) {
    const local = getLocalDateTimeParts(new Date(guessMs), timezone);
    const localMs = Date.UTC(
      local.year,
      local.month - 1,
      local.day,
      local.hour,
      local.minute,
      local.second,
    );
    const diffMs = localMs - targetLocalMs;
    if (diffMs === 0) {
      break;
    }
    guessMs -= diffMs;
  }

  return new Date(guessMs).toISOString();
}

function getLocalDateTimeParts(
  date: Date,
  timezone: string,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const get = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");

  const hour = get("hour") % 24;

  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour,
    minute: get("minute"),
    second: get("second"),
  };
}

function addDaysToDateString(dateStr: string, days: number): string {
  const [year, month, day] = dateStr.split("-").map((part) => Number(part));
  const date = new Date(Date.UTC(year, month - 1, day + days));

  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");

  return `${y}-${m}-${d}`;
}

// ── buildBriefingPrompt ──────────────────────────────────────

export function buildBriefingPrompt(data: BriefingData): string {
  const blocks: string[] = [];

  blocks.push(
    [
      `You are a personal assistant generating a morning briefing for ${data.date}.`,
      `promptVersion=${BRIEFING_PROMPT_VERSION}`,
      "",
      "Generate a concise, actionable briefing. Lead with the most time-sensitive items.",
      "Use short paragraphs or bullet points. Be direct.",
    ].join("\n")
  );

  // ── Calendar ──
  const calendarLines: string[] = [`## Calendar (${data.calendar.status})`];
  if (data.calendar.status === "not_connected") {
    calendarLines.push("Calendar integration not yet configured.");
  } else if (data.calendar.status === "error") {
    calendarLines.push("Calendar data temporarily unavailable due to an error.");
  } else if (data.calendar.events.length === 0) {
    calendarLines.push("No events scheduled today.");
  } else {
    for (const evt of data.calendar.events) {
      const loc = evt.location ? ` — ${evt.location}` : "";
      if (evt.allDay) {
        calendarLines.push(`- All day: ${evt.title}${loc}`);
      } else {
        const startTime = evt.start.slice(11, 16);
        const endTime = evt.end.slice(11, 16);
        calendarLines.push(`- ${startTime}–${endTime}: ${evt.title}${loc}`);
      }
    }
  }
  blocks.push(calendarLines.join("\n"));

  // ── Urgent Items ──
  const urgentLines: string[] = [
    `## Urgent Items (${data.urgentItems.length})`,
  ];
  if (data.urgentItems.length === 0) {
    urgentLines.push("No urgent items.");
  } else {
    for (const item of data.urgentItems) {
      urgentLines.push(
        `- [P${item.priority}] ${item.subject} (from: ${item.from}) — ${item.summary}`
      );
    }
  }
  blocks.push(urgentLines.join("\n"));

  // ── Deadlines ──
  const deadlineLines: string[] = [
    `## Upcoming Deadlines (${data.deadlines.length}, next 7 days)`,
  ];
  if (data.deadlines.length === 0) {
    deadlineLines.push("No upcoming deadlines.");
  } else {
    for (const dl of data.deadlines) {
      deadlineLines.push(`- ${dl.dueDate}: ${dl.description} (${dl.status})`);
    }
  }
  blocks.push(deadlineLines.join("\n"));

  // ── Pending Actions ──
  const actionLines: string[] = [
    `## Pending Actions (${data.pendingActions.length} awaiting approval)`,
  ];
  if (data.pendingActions.length === 0) {
    actionLines.push("No pending actions.");
  } else {
    for (const action of data.pendingActions) {
      actionLines.push(
        `- ${action.actionType} on ${action.resourceId} [${action.riskLevel}]`
      );
    }
  }
  blocks.push(actionLines.join("\n"));

  return blocks.join("\n\n");
}

// ── Structured Fallback ──────────────────────────────────────

function buildFallbackSummary(data: BriefingData): string {
  const lines: string[] = [`Briefing for ${data.date}`];

  if (data.calendar.status === "connected" && data.calendar.events.length > 0) {
    lines.push(`\nCalendar: ${data.calendar.events.length} event(s) today.`);
    for (const evt of data.calendar.events) {
      lines.push(`  - ${evt.start.slice(11, 16)} ${evt.title}`);
    }
  } else if (data.calendar.status === "not_connected") {
    lines.push("\nCalendar: Not connected.");
  }

  if (data.urgentItems.length > 0) {
    lines.push(`\nUrgent: ${data.urgentItems.length} item(s).`);
    for (const item of data.urgentItems) {
      lines.push(`  - [P${item.priority}] ${item.subject}`);
    }
  }

  if (data.deadlines.length > 0) {
    lines.push(`\nDeadlines: ${data.deadlines.length} in next 7 days.`);
    for (const dl of data.deadlines) {
      lines.push(`  - ${dl.dueDate}: ${dl.description}`);
    }
  }

  if (data.pendingActions.length > 0) {
    lines.push(`\nPending Actions: ${data.pendingActions.length} awaiting approval.`);
  }

  if (
    data.urgentItems.length === 0 &&
    data.deadlines.length === 0 &&
    data.pendingActions.length === 0
  ) {
    lines.push("\nNothing urgent. Enjoy your day.");
  }

  return lines.join("\n");
}

// ── Use Case ─────────────────────────────────────────────────

export async function generateDailyBriefing(
  deps: GenerateDailyBriefingDeps,
  input: GenerateDailyBriefingInput
): Promise<GenerateDailyBriefingResult> {
  const { logger } = deps;
  const dateStr = getLocalDateString(input.now, input.timezone);

  // ── Derive date boundaries in UTC ──
  const dayStartUTC = startOfDayUTC(dateStr, input.timezone);
  const weekEndUTC = startOfDayUTC(addDaysToDateString(dateStr, 7), input.timezone);
  const nextDayUTC = startOfDayUTC(addDaysToDateString(dateStr, 1), input.timezone);

  // ── 1. Urgent items (priority ≤ 2) ──
  const classifications = input.userId
    ? deps.classificationRepo.findAll({
        minPriority: MAX_URGENT_PRIORITY as 1 | 2 | 3 | 4 | 5,
        limit: MAX_URGENT_ITEMS,
        userId: input.userId,
      })
    : [];

  const urgentItems: UrgentItemSummary[] = [];
  for (const cls of classifications) {
    if (cls.priority > MAX_URGENT_PRIORITY) continue;
    const item = deps.inboundItemRepo.findById(cls.inboundItemId);
    if (!item) continue;
    urgentItems.push({
      id: item.id,
      subject: item.subject,
      from: item.from,
      source: item.source,
      category: cls.category,
      priority: cls.priority,
      summary: cls.summary,
    });
  }

  // ── 2. Deadlines (next 7 days, open only) ──
  const deadlines = input.userId
    ? deps.deadlineRepo.findByDateRange(dayStartUTC, weekEndUTC, "open", input.userId)
    : [];

  // ── 3. Pending actions ──
  const pendingActions = deps.listPendingActions();

  // ── 4. Calendar events ──
  let calendar: BriefingData["calendar"];
  if (!deps.calendarPort) {
    calendar = { status: "not_connected", events: [] };
  } else {
    try {
      const events = await deps.calendarPort.listEvents(dayStartUTC, nextDayUTC);
      calendar = { status: "connected", events };
    } catch (error) {
      logger.error("Calendar fetch failed during briefing", {
        error: error instanceof Error ? error.message : String(error),
      });
      calendar = { status: "error", events: [] };
    }
  }

  // ── Assemble BriefingData ──
  const data: BriefingData = {
    date: dateStr,
    urgentItems,
    deadlines,
    pendingActions,
    calendar,
  };

  // ── 5. Synthesize ──
  let summary: string;
  try {
    const prompt = buildBriefingPrompt(data);
    summary = await deps.synthesizer.synthesize(prompt);
  } catch (error) {
    logger.warn("Briefing synthesis failed, using fallback", {
      error: error instanceof Error ? error.message : String(error),
    });
    summary = buildFallbackSummary(data);
  }

  return { data, summary };
}
