import { describe, it, expect, vi } from "vitest";
import {
  generateDailyBriefing,
  buildBriefingPrompt,
  type GenerateDailyBriefingDeps,
  type GenerateDailyBriefingInput,
  type BriefingData,
} from "./generate-daily-briefing.js";
import type {
  ClassificationRepository,
  InboundItemRepository,
  DeadlineRepository,
  ActionLogRepository,
  CalendarPort,
  CalendarEvent,
  SynthesisPort,
  Logger,
  Classification,
  InboundItem,
  Deadline,
  ActionLogEntry,
  Category,
  Priority,
} from "@oneon/domain";

// ── Helpers ──────────────────────────────────────────────────

function createMockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeItem(id: string, overrides: Partial<InboundItem> = {}): InboundItem {
  return {
    id,
    userId: null,
    source: "outlook",
    externalId: `ext-${id}`,
    from: "sender@example.com",
    subject: `Subject ${id}`,
    bodyPreview: "Preview body",
    receivedAt: "2026-04-17T08:00:00Z",
    rawJson: "{}",
    threadId: null,
    labels: "[]",
    classifiedAt: "2026-04-17T08:05:00Z",
    classifyAttempts: 1,
    createdAt: "2026-04-17T08:00:00Z",
    updatedAt: "2026-04-17T08:00:00Z",
    ...overrides,
  };
}

function makeClassification(
  itemId: string,
  overrides: Partial<Classification> = {}
): Classification {
  return {
    id: `cls-${itemId}`,
    userId: null,
    inboundItemId: itemId,
    category: "urgent" as Category,
    priority: 1 as Priority,
    summary: `Urgent summary for ${itemId}`,
    actionItems: '["Respond ASAP"]',
    followUpNeeded: true,
    model: "claude-3-5-haiku",
    promptVersion: "v1",
    createdAt: "2026-04-17T08:05:00Z",
    ...overrides,
  };
}

function makeDeadline(
  itemId: string,
  overrides: Partial<Deadline> = {}
): Deadline {
  return {
    id: `dl-${itemId}`,
    userId: null,
    inboundItemId: itemId,
    dueDate: "2026-04-20",
    description: "Report due",
    confidence: 0.9,
    status: "open",
    createdAt: "2026-04-17T08:00:00Z",
    updatedAt: "2026-04-17T08:00:00Z",
    ...overrides,
  };
}

function makeAction(overrides: Partial<ActionLogEntry> = {}): ActionLogEntry {
  return {
    id: "action-1",
    userId: null,
    resourceId: "item-1",
    actionType: "notify",
    riskLevel: "approval_required",
    status: "proposed",
    payloadJson: "{}",
    resultJson: null,
    errorJson: null,
    rollbackJson: null,
    createdAt: "2026-04-17T08:10:00Z",
    updatedAt: "2026-04-17T08:10:00Z",
    ...overrides,
  };
}

function makeCalendarEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "evt-1",
    title: "Team Standup",
    start: "2026-04-17T09:00:00Z",
    end: "2026-04-17T09:30:00Z",
    allDay: false,
    description: null,
    attendees: ["alice@example.com"],
    location: "Zoom",
    ...overrides,
  };
}

function createDeps(overrides: Partial<GenerateDailyBriefingDeps> = {}): GenerateDailyBriefingDeps {
  const classificationRepo: ClassificationRepository = {
    create: vi.fn(),
    findByInboundItemId: vi.fn(() => null),
    findAll: vi.fn(() => []),
    count: vi.fn(() => 0),
  };

  const inboundItemRepo: InboundItemRepository = {
    upsert: vi.fn(),
    findById: vi.fn(() => null),
    findBySourceAndExternalId: vi.fn(() => null),
    findUnclassified: vi.fn(() => []),
    findAll: vi.fn(() => []),
    search: vi.fn(() => []),
    markClassified: vi.fn(),
    incrementClassifyAttempts: vi.fn(),
    count: vi.fn(() => 0),
  };

  const deadlineRepo: DeadlineRepository = {
    create: vi.fn(),
    findByInboundItemId: vi.fn(() => []),
    findByDateRange: vi.fn(() => []),
    findOverdue: vi.fn(() => []),
    updateStatus: vi.fn(),
    count: vi.fn(() => 0),
  };

  const actionLogRepo: ActionLogRepository = {
    create: vi.fn() as ActionLogRepository["create"],
    findByResourceAndType: vi.fn(() => null),
    findByStatus: vi.fn(() => []),
    updateStatus: vi.fn(),
    findAll: vi.fn(() => []),
    count: vi.fn(() => 0),
  };

  const synthesizer: SynthesisPort = {
    synthesize: vi.fn(async () => "Your morning briefing summary."),
  };

  return {
    classificationRepo,
    inboundItemRepo,
    deadlineRepo,
    actionLogRepo,
    synthesizer,
    logger: createMockLogger(),
    ...overrides,
  };
}

function defaultInput(overrides: Partial<GenerateDailyBriefingInput> = {}): GenerateDailyBriefingInput {
  return {
    now: new Date("2026-04-17T07:00:00Z"),
    timezone: "UTC",
    ...overrides,
  };
}

// ── Tests: generateDailyBriefing ─────────────────────────────

describe("generateDailyBriefing", () => {
  it("returns stable shape with all-empty data when repos are empty", async () => {
    const deps = createDeps();
    const result = await generateDailyBriefing(deps, defaultInput());

    expect(result.data).toEqual({
      date: "2026-04-17",
      urgentItems: [],
      deadlines: [],
      pendingActions: [],
      calendar: { status: "not_connected", events: [] },
    });
    expect(typeof result.summary).toBe("string");
    expect(result.summary.length).toBeGreaterThan(0);
  });

  it("populates urgentItems from classifications with priority ≤ 2", async () => {
    const item1 = makeItem("item-1");
    const cls1 = makeClassification("item-1", { priority: 1 as Priority });
    const item2 = makeItem("item-2");
    const cls2 = makeClassification("item-2", { priority: 3 as Priority, category: "work" as Category });

    const deps = createDeps();
    vi.mocked(deps.classificationRepo.findAll).mockReturnValue([cls1, cls2]);
    vi.mocked(deps.inboundItemRepo.findById).mockImplementation((id: string) => {
      if (id === "item-1") return item1;
      if (id === "item-2") return item2;
      return null;
    });

    const result = await generateDailyBriefing(deps, defaultInput());

    // Only priority ≤ 2 should appear in urgentItems
    expect(result.data.urgentItems).toHaveLength(1);
    expect(result.data.urgentItems[0].id).toBe("item-1");
    expect(result.data.urgentItems[0].priority).toBe(1);
  });

  it("populates deadlines from the next 7 days", async () => {
    const dl1 = makeDeadline("item-1", { dueDate: "2026-04-20" });
    const dl2 = makeDeadline("item-2", { dueDate: "2026-04-24" });

    const deps = createDeps();
    vi.mocked(deps.deadlineRepo.findByDateRange).mockReturnValue([dl1, dl2]);

    const result = await generateDailyBriefing(deps, defaultInput());

    expect(result.data.deadlines).toHaveLength(2);

    // Verify date range was queried correctly: from today to today+7d
    expect(deps.deadlineRepo.findByDateRange).toHaveBeenCalledWith(
      "2026-04-17T00:00:00.000Z",
      "2026-04-24T00:00:00.000Z",
      "open"
    );
  });

  it("populates pendingActions with status=proposed", async () => {
    const action1 = makeAction({ id: "act-1", status: "proposed", riskLevel: "approval_required" });
    const action2 = makeAction({ id: "act-2", status: "proposed", riskLevel: "auto" });

    const deps = createDeps();
    vi.mocked(deps.actionLogRepo.findByStatus).mockReturnValue([action1, action2]);

    const result = await generateDailyBriefing(deps, defaultInput());

    expect(result.data.pendingActions).toHaveLength(2);
    expect(deps.actionLogRepo.findByStatus).toHaveBeenCalledWith("proposed");
  });

  it("returns calendar.status='not_connected' when calendarPort absent", async () => {
    const deps = createDeps(); // no calendarPort
    const result = await generateDailyBriefing(deps, defaultInput());

    expect(result.data.calendar).toEqual({ status: "not_connected", events: [] });
  });

  it("returns calendar.status='connected' with events when calendarPort present", async () => {
    const events: CalendarEvent[] = [
      makeCalendarEvent({ id: "evt-1", title: "Standup", start: "2026-04-17T09:00:00Z", end: "2026-04-17T09:30:00Z" }),
      makeCalendarEvent({ id: "evt-2", title: "1:1 with Manager", start: "2026-04-17T14:00:00Z", end: "2026-04-17T14:30:00Z" }),
    ];

    const calendarPort: CalendarPort = {
      listEvents: vi.fn(async () => events),
      createEvent: vi.fn(),
      updateEvent: vi.fn(),
      searchEvents: vi.fn(),
    };

    const deps = createDeps({ calendarPort });
    const result = await generateDailyBriefing(deps, defaultInput());

    expect(result.data.calendar.status).toBe("connected");
    expect(result.data.calendar.events).toHaveLength(2);
    expect(result.data.calendar.events[0].title).toBe("Standup");

    // Verify listEvents called with day boundaries in UTC
    expect(calendarPort.listEvents).toHaveBeenCalledWith(
      "2026-04-17T00:00:00.000Z",
      "2026-04-18T00:00:00.000Z"
    );
  });

  it("returns calendar.status='error' when calendarPort throws", async () => {
    const calendarPort: CalendarPort = {
      listEvents: vi.fn(async () => { throw new Error("OAuth expired"); }),
      createEvent: vi.fn(),
      updateEvent: vi.fn(),
      searchEvents: vi.fn(),
    };

    const deps = createDeps({ calendarPort });
    const result = await generateDailyBriefing(deps, defaultInput());

    expect(result.data.calendar.status).toBe("error");
    expect(result.data.calendar.events).toEqual([]);
    expect(deps.logger.error).toHaveBeenCalled();
  });

  it("calls synthesizer with a prompt and returns its output as summary", async () => {
    const deps = createDeps();
    vi.mocked(deps.synthesizer.synthesize).mockResolvedValue("Here is your briefing: nothing urgent.");

    const result = await generateDailyBriefing(deps, defaultInput());

    expect(result.summary).toBe("Here is your briefing: nothing urgent.");
    expect(deps.synthesizer.synthesize).toHaveBeenCalledOnce();
    expect(typeof (deps.synthesizer.synthesize as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("string");
  });

  it("falls back to structured text when synthesizer throws", async () => {
    const dl = makeDeadline("item-1", { dueDate: "2026-04-20" });
    const deps = createDeps();
    vi.mocked(deps.deadlineRepo.findByDateRange).mockReturnValue([dl]);
    vi.mocked(deps.synthesizer.synthesize).mockRejectedValue(new Error("Sonnet down"));

    const result = await generateDailyBriefing(deps, defaultInput());

    expect(result.summary).toContain("Briefing for 2026-04-17");
    expect(result.summary).toContain("Deadline");
    expect(deps.logger.warn).toHaveBeenCalled();
  });

  it("uses 'now' param to derive date — boundary test start of day", async () => {
    const deps = createDeps();
    // 2026-04-18 at 00:00:01 UTC → date should be 2026-04-18
    const result = await generateDailyBriefing(deps, defaultInput({
      now: new Date("2026-04-18T00:00:01Z"),
      timezone: "UTC",
    }));

    expect(result.data.date).toBe("2026-04-18");
    expect(deps.deadlineRepo.findByDateRange).toHaveBeenCalledWith(
      "2026-04-18T00:00:00.000Z",
      "2026-04-25T00:00:00.000Z",
      "open"
    );
  });

  it("uses timezone offset — end of day in US/Eastern is next day in UTC", async () => {
    const deps = createDeps();
    // 2026-04-17 at 23:00 UTC → In America/New_York (UTC-4), still April 17 at 19:00
    const result = await generateDailyBriefing(deps, defaultInput({
      now: new Date("2026-04-17T23:00:00Z"),
      timezone: "America/New_York",
    }));

    expect(result.data.date).toBe("2026-04-17");
  });

  it("timezone: morning in Asia/Tokyo is still previous day in UTC", async () => {
    const deps = createDeps();
    // 2026-04-18 at 02:00 UTC → In Asia/Tokyo (UTC+9) it's 11:00 April 18
    const result = await generateDailyBriefing(deps, defaultInput({
      now: new Date("2026-04-18T02:00:00Z"),
      timezone: "Asia/Tokyo",
    }));

    expect(result.data.date).toBe("2026-04-18");
  });
});

// ── Tests: buildBriefingPrompt ───────────────────────────────

describe("buildBriefingPrompt", () => {
  const emptyData: BriefingData = {
    date: "2026-04-17",
    urgentItems: [],
    deadlines: [],
    pendingActions: [],
    calendar: { status: "not_connected", events: [] },
  };

  it("includes date in the prompt", () => {
    const prompt = buildBriefingPrompt(emptyData);
    expect(prompt).toContain("2026-04-17");
  });

  it("includes 'Calendar integration not yet configured' when not_connected", () => {
    const prompt = buildBriefingPrompt(emptyData);
    expect(prompt).toContain("not yet configured");
  });

  it("includes calendar event titles when connected", () => {
    const data: BriefingData = {
      ...emptyData,
      calendar: {
        status: "connected",
        events: [makeCalendarEvent({ title: "Sprint Planning" })],
      },
    };
    const prompt = buildBriefingPrompt(data);
    expect(prompt).toContain("Sprint Planning");
  });

  it("includes urgent item subjects", () => {
    const data: BriefingData = {
      ...emptyData,
      urgentItems: [{
        id: "item-1",
        subject: "Server outage alert",
        from: "ops@example.com",
        source: "outlook",
        category: "urgent",
        priority: 1,
        summary: "Production server is down",
      }],
    };
    const prompt = buildBriefingPrompt(data);
    expect(prompt).toContain("Server outage alert");
    expect(prompt).toContain("Production server is down");
  });

  it("includes deadline descriptions and due dates", () => {
    const data: BriefingData = {
      ...emptyData,
      deadlines: [makeDeadline("item-1", { dueDate: "2026-04-20", description: "Q2 Report" })],
    };
    const prompt = buildBriefingPrompt(data);
    expect(prompt).toContain("Q2 Report");
    expect(prompt).toContain("2026-04-20");
  });

  it("includes pending actions section", () => {
    const data: BriefingData = {
      ...emptyData,
      pendingActions: [makeAction({ actionType: "draft_reply", riskLevel: "approval_required" })],
    };
    const prompt = buildBriefingPrompt(data);
    expect(prompt).toContain("Pending");
    expect(prompt).toContain("draft_reply");
    expect(prompt).toContain("approval_required");
  });

  it("includes calendar error status in prompt", () => {
    const data: BriefingData = {
      ...emptyData,
      calendar: { status: "error", events: [] },
    };
    const prompt = buildBriefingPrompt(data);
    expect(prompt).toContain("error");
  });

  it("renders all-day events as 'All day' instead of time range", () => {
    const data: BriefingData = {
      ...emptyData,
      calendar: {
        status: "connected",
        events: [
          makeCalendarEvent({ title: "Company Holiday", allDay: true, start: "2026-04-17", end: "2026-04-18" }),
        ],
      },
    };
    const prompt = buildBriefingPrompt(data);
    expect(prompt).toContain("All day: Company Holiday");
    expect(prompt).not.toContain("T00:00");
  });
});
