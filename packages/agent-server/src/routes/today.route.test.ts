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
    } as unknown as DeadlineRepository,
    actionLogRepo: {
      findByStatus: vi.fn().mockReturnValue([]),
      count: vi.fn().mockReturnValue(0),
    } as unknown as ActionLogRepository,
    notificationRepo: {
      countUnread: vi.fn().mockReturnValue(0),
    } as unknown as NotificationRepository,
    calendarPort: null,
    logger,
  };

  app = express();
  app.use((req, _res, next) => { req.userId = "user-A"; next(); });
  app.use("/api/today", createTodayRouter(deps));
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
    app = express();
    app.use((req, _res, next) => { req.userId = "user-A"; next(); });
    app.use("/api/today", createTodayRouter(deps));

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
    app = express();
    app.use((req, _res, next) => { req.userId = "user-A"; next(); });
    app.use("/api/today", createTodayRouter(deps));

    const res = await request(app).get("/api/today");
    expect(res.status).toBe(200);
    expect(res.body.calendar.status).toBe("unavailable");
  });
});
