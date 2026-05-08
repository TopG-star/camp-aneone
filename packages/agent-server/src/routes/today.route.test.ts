import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type {
  ClassificationRepository,
  InboundItem,
  InboundItemRepository,
  DeadlineRepository,
  ActionLogRepository,
  NotificationRepository,
  PreferenceRepository,
  CalendarPort,
  Logger,
  Source,
  Category,
} from "@oneon/domain";
import { createTodayRouter, type TodayRouteDeps } from "./today.route.js";

const logger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

let deps: TodayRouteDeps;
let app: express.Express;

function mountApp() {
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.userId = "user-A"; next(); });
  app.use("/api/today", createTodayRouter(deps));
}

beforeEach(() => {
  deps = {
    classificationRepo: {
      findByInboundItemId: vi.fn().mockReturnValue(null),
    } as unknown as ClassificationRepository,
    inboundItemRepo: {
      findAll: vi.fn().mockReturnValue([]),
      count: vi.fn().mockReturnValue(0),
    } as unknown as InboundItemRepository,
    deadlineRepo: {
      findByDateRange: vi.fn().mockReturnValue([]),
      findOverdue: vi.fn().mockReturnValue([]),
    } as unknown as DeadlineRepository,
    actionLogRepo: {
      findByStatus: vi.fn().mockReturnValue([]),
      count: vi.fn().mockReturnValue(0),
    } as unknown as ActionLogRepository,
    notificationRepo: {
      countUnread: vi.fn().mockReturnValue(0),
    } as unknown as NotificationRepository,
    preferenceRepo: {
      get: vi.fn().mockReturnValue(null),
      set: vi.fn(),
      getAll: vi.fn().mockReturnValue([]),
      delete: vi.fn(),
    } as unknown as PreferenceRepository,
    calendarPort: null,
    logger,
  };

  mountApp();
});

describe("GET /api/today", () => {
  it("returns aggregated today data with defaults", async () => {
    const res = await request(app).get("/api/today");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("date");
    expect(res.body).toHaveProperty("briefingSummary", null);
    expect(res.body.calendar).toEqual({ status: "unavailable", events: [] });
    expect(res.body.urgentItems).toEqual([]);
    expect(res.body.deadlines).toEqual([]);
    expect(res.body.triageQueue).toEqual([]);
    expect(res.body.pendingActions).toEqual({ count: 0, items: [] });
    expect(res.body.counts).toEqual({
      unreadNotifications: 0,
      totalInbox: 0,
      pendingActions: 0,
    });
  });

  it("includes urgent items with priority <= 2", async () => {
    const item: InboundItem = {
      id: "item-1",
      userId: null,
      source: "gmail" as Source,
      subject: "Urgent!",
      externalId: "x",
      from: "a@b.com",
      bodyPreview: "",
      receivedAt: new Date().toISOString(),
      rawJson: "{}",
      threadId: null,
      labels: "[]",
      classifiedAt: null,
      classifyAttempts: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    vi.mocked(deps.inboundItemRepo.findAll).mockReturnValue([item]);
    vi.mocked(deps.classificationRepo.findByInboundItemId).mockReturnValue({
      id: "cls-1",
      userId: null,
      inboundItemId: "item-1",
      category: "action_needed" as Category,
      priority: 1,
      summary: "Urgent item",
      actionItems: "[]",
      followUpNeeded: false,
      model: "test",
      promptVersion: "1.0",
      createdAt: new Date().toISOString(),
    });

    const res = await request(app).get("/api/today");
    expect(res.body.urgentItems).toHaveLength(1);
    expect(res.body.urgentItems[0].priority).toBe(1);
  });

  it("uses calendar port when available", async () => {
    const calendarPort: CalendarPort = {
      listEvents: vi.fn().mockResolvedValue([{ id: "ev-1", summary: "Meeting" }]),
      createEvent: vi.fn(),
      updateEvent: vi.fn(),
      searchEvents: vi.fn(),
    };
    deps.calendarPort = calendarPort;
    mountApp();

    const res = await request(app).get("/api/today");
    expect(res.body.calendar.status).toBe("connected");
    expect(res.body.calendar.events).toHaveLength(1);
  });

  it("handles calendar port failure gracefully", async () => {
    const calendarPort: CalendarPort = {
      listEvents: vi.fn().mockRejectedValue(new Error("timeout")),
      createEvent: vi.fn(),
      updateEvent: vi.fn(),
      searchEvents: vi.fn(),
    };
    deps.calendarPort = calendarPort;
    mountApp();

    const res = await request(app).get("/api/today");
    expect(res.status).toBe(200);
    expect(res.body.calendar.status).toBe("unavailable");
  });

  it("builds a single ranked triage queue across email, Teams incidents, PR reviews, and deadline pressure", async () => {
    const nowIso = new Date().toISOString();
    const oneHourAgoIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    const urgentEmail: InboundItem = {
      id: "item-email-urgent",
      userId: null,
      source: "gmail" as Source,
      subject: "Production access issue",
      externalId: "g-1",
      from: "vp@company.com",
      bodyPreview: "Need immediate help on failed production sign-ins.",
      receivedAt: nowIso,
      rawJson: "{}",
      threadId: null,
      labels: "[]",
      classifiedAt: null,
      classifyAttempts: 0,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    const teamsIncident: InboundItem = {
      id: "item-teams-incident",
      userId: null,
      source: "teams" as Source,
      subject: "SEV1 incident: Payments API down",
      externalId: "t-1",
      from: "oncall@company.com",
      bodyPreview: "Incident bridge started. Customer impact confirmed.",
      receivedAt: oneHourAgoIso,
      rawJson: "{}",
      threadId: null,
      labels: JSON.stringify(["Ops", "Incident"]),
      classifiedAt: null,
      classifyAttempts: 0,
      createdAt: oneHourAgoIso,
      updatedAt: oneHourAgoIso,
    };

    const githubReview: InboundItem = {
      id: "item-github-review",
      userId: null,
      source: "github" as Source,
      subject: "[owner/repo] PR #42: Stabilize queue ranking",
      externalId: "gh-1",
      from: "teammate",
      bodyPreview: "Review requested before Monday deploy.",
      receivedAt: nowIso,
      rawJson: "{}",
      threadId: "owner/repo#42",
      labels: JSON.stringify(["pull_request", "review_requested"]),
      classifiedAt: null,
      classifyAttempts: 0,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    vi.mocked(deps.inboundItemRepo.findAll).mockReturnValue([
      urgentEmail,
      teamsIncident,
      githubReview,
    ]);

    vi.mocked(deps.classificationRepo.findByInboundItemId).mockImplementation((id: string) => {
      if (id === "item-email-urgent") {
        return {
          id: "cls-email",
          userId: null,
          inboundItemId: id,
          category: "urgent" as Category,
          priority: 1,
          summary: "Exec escalation needs immediate response",
          actionItems: "[]",
          followUpNeeded: true,
          model: "test",
          promptVersion: "1.0",
          createdAt: nowIso,
        };
      }
      if (id === "item-teams-incident") {
        return {
          id: "cls-teams",
          userId: null,
          inboundItemId: id,
          category: "action_needed" as Category,
          priority: 2,
          summary: "Incident response active",
          actionItems: "[]",
          followUpNeeded: true,
          model: "test",
          promptVersion: "1.0",
          createdAt: nowIso,
        };
      }
      return null;
    });

    vi.mocked(deps.deadlineRepo.findByDateRange).mockReturnValue([
      {
        id: "dl-soon",
        userId: null,
        inboundItemId: "item-email-urgent",
        dueDate: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
        description: "Send customer update",
        confidence: 0.9,
        status: "open",
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    ]);

    vi.mocked(deps.deadlineRepo.findOverdue).mockReturnValue([
      {
        id: "dl-overdue",
        userId: null,
        inboundItemId: "item-teams-incident",
        dueDate: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
        description: "Post incident status page update",
        confidence: 0.95,
        status: "open",
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    ]);

    const res = await request(app).get("/api/today");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.triageQueue)).toBe(true);
    expect(res.body.triageQueue.length).toBeGreaterThanOrEqual(4);

    const kinds = new Set(res.body.triageQueue.map((item: { kind: string }) => item.kind));
    expect(kinds.has("urgent_email")).toBe(true);
    expect(kinds.has("teams_incident")).toBe(true);
    expect(kinds.has("pr_review")).toBe(true);
    expect(kinds.has("deadline_pressure")).toBe(true);

    const scores = res.body.triageQueue.map((item: { score: number }) => item.score);
    const sorted = [...scores].sort((a, b) => b - a);
    expect(scores).toEqual(sorted);

    expect(res.body.triageQueue[0].kind).toBe("deadline_pressure");
    expect(res.body.triageQueue[0].title).toContain("Post incident status page update");
    expect(res.body.triageQueue[0]).toMatchObject({
      explainability: {
        summary: expect.any(String),
        signals: expect.any(Array),
      },
      observedAt: expect.any(String),
      lastUpdatedAt: expect.any(String),
    });
  });

  it("snoozes and dismisses triage items so they do not repeat", async () => {
    const nowIso = new Date().toISOString();
    const urgentEmail: InboundItem = {
      id: "item-suppress-me",
      userId: null,
      source: "gmail" as Source,
      subject: "Suppress me",
      externalId: "g-suppress",
      from: "lead@company.com",
      bodyPreview: "Need triage now",
      receivedAt: nowIso,
      rawJson: "{}",
      threadId: null,
      labels: "[]",
      classifiedAt: null,
      classifyAttempts: 0,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    vi.mocked(deps.inboundItemRepo.findAll).mockReturnValue([urgentEmail]);
    vi.mocked(deps.classificationRepo.findByInboundItemId).mockReturnValue({
      id: "cls-suppress",
      userId: null,
      inboundItemId: "item-suppress-me",
      category: "urgent" as Category,
      priority: 1,
      summary: "urgent",
      actionItems: "[]",
      followUpNeeded: true,
      model: "test",
      promptVersion: "1.0",
      createdAt: nowIso,
    });

    const preferenceState = new Map<string, string>();
    vi.mocked(deps.preferenceRepo.get).mockImplementation((key: string) => preferenceState.get(key) ?? null);
    vi.mocked(deps.preferenceRepo.set).mockImplementation((key: string, value: string) => {
      preferenceState.set(key, value);
      return { key, value, updatedAt: new Date().toISOString() };
    });

    const initial = await request(app).get("/api/today");
    expect(initial.status).toBe(200);
    expect(initial.body.triageQueue.length).toBeGreaterThan(0);
    const triageId = initial.body.triageQueue[0].id as string;

    const snooze = await request(app)
      .post(`/api/today/triage/${encodeURIComponent(triageId)}/snooze`)
      .send({ hours: 24 });
    expect(snooze.status).toBe(200);

    const afterSnooze = await request(app).get("/api/today");
    expect(afterSnooze.status).toBe(200);
    expect(afterSnooze.body.triageQueue.some((item: { id: string }) => item.id === triageId)).toBe(false);

    const dismiss = await request(app)
      .post(`/api/today/triage/${encodeURIComponent(triageId)}/dismiss`)
      .send({});
    expect(dismiss.status).toBe(200);

    const afterDismiss = await request(app).get("/api/today");
    expect(afterDismiss.status).toBe(200);
    expect(afterDismiss.body.triageQueue.some((item: { id: string }) => item.id === triageId)).toBe(false);
  });
});
