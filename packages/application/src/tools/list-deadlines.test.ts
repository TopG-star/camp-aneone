import { describe, it, expect, vi } from "vitest";
import type { Deadline } from "@oneon/domain";
import {
  createListDeadlinesTool,
  listDeadlinesSchema,
  type ListDeadlinesDeps,
} from "./list-deadlines.js";
import { createToolRegistry } from "./tool-registry.js";

// ── Fixtures ─────────────────────────────────────────────────

function makeDeadline(overrides: Partial<Deadline> = {}): Deadline {
  return {
    id: "dl-001",
    userId: null,
    inboundItemId: "item-001",
    dueDate: "2026-04-20T17:00:00Z",
    description: "Submit quarterly report",
    confidence: 0.95,
    status: "open",
    createdAt: "2026-04-17T08:00:00Z",
    updatedAt: "2026-04-17T08:00:00Z",
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<ListDeadlinesDeps> = {}
): ListDeadlinesDeps {
  return {
    deadlineRepo: {
      create: vi.fn(),
      findByInboundItemId: vi.fn().mockReturnValue([]),
      findByDateRange: vi.fn().mockReturnValue([]),
      findOverdue: vi.fn().mockReturnValue([]),
      updateStatus: vi.fn(),
      count: vi.fn().mockReturnValue(0),
    },
    ...overrides,
  };
}

// ── Schema Contract Tests ────────────────────────────────────

describe("listDeadlinesSchema", () => {
  it("accepts empty input with defaults", () => {
    const result = listDeadlinesSchema.parse({});
    expect(result.from).toBeInstanceOf(Date);
    expect(result.to).toBeInstanceOf(Date);
    expect(result.status).toBeUndefined();
  });

  it("defaults from to now and to to 7 days ahead", () => {
    const before = new Date();
    const result = listDeadlinesSchema.parse({});
    const after = new Date();

    // from should be approximately now
    expect(result.from.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(result.from.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);

    // to should be approximately 7 days from now
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(result.to.getTime()).toBeGreaterThanOrEqual(
      before.getTime() + sevenDaysMs - 1000
    );
    expect(result.to.getTime()).toBeLessThanOrEqual(
      after.getTime() + sevenDaysMs + 1000
    );
  });

  it("accepts valid complete input with dates", () => {
    const result = listDeadlinesSchema.parse({
      from: "2026-04-10T00:00:00Z",
      to: "2026-04-20T00:00:00Z",
      status: "open",
    });
    expect(result.from).toBeInstanceOf(Date);
    expect(result.to).toBeInstanceOf(Date);
    expect(result.status).toBe("open");
  });

  it("coerces string dates to Date objects", () => {
    const result = listDeadlinesSchema.parse({
      from: "2026-04-10T09:00:00Z",
      to: "2026-04-17T09:00:00Z",
    });
    expect(result.from.toISOString()).toBe("2026-04-10T09:00:00.000Z");
    expect(result.to.toISOString()).toBe("2026-04-17T09:00:00.000Z");
  });

  it("rejects invalid status values", () => {
    expect(() =>
      listDeadlinesSchema.parse({ status: "expired" })
    ).toThrow();
  });

  it("accepts all valid status values", () => {
    for (const status of ["open", "done", "dismissed"]) {
      const result = listDeadlinesSchema.parse({ status });
      expect(result.status).toBe(status);
    }
  });

  it("rejects invalid date strings", () => {
    expect(() =>
      listDeadlinesSchema.parse({ from: "not-a-date" })
    ).toThrow();
  });
});

// ── Behavioral Tests ─────────────────────────────────────────

describe("list_deadlines tool", () => {
  it("returns empty data and summary when no deadlines found", async () => {
    const deps = makeDeps();
    const tool = createListDeadlinesTool(deps);

    const result = await tool.execute({
      from: new Date("2026-04-17T00:00:00Z"),
      to: new Date("2026-04-24T00:00:00Z"),
    });

    expect(result.data).toEqual([]);
    expect(result.summary).toContain("0");
  });

  it("calls deadlineRepo.findByDateRange with ISO strings and status", () => {
    const deps = makeDeps();
    const tool = createListDeadlinesTool(deps);
    const from = new Date("2026-04-17T00:00:00Z");
    const to = new Date("2026-04-24T00:00:00Z");

    tool.execute({ from, to, status: "open" });

    expect(deps.deadlineRepo.findByDateRange).toHaveBeenCalledWith(
      from.toISOString(),
      to.toISOString(),
      "open"
    );
  });

  it("calls findByDateRange without status when not provided", () => {
    const deps = makeDeps();
    const tool = createListDeadlinesTool(deps);
    const from = new Date("2026-04-17T00:00:00Z");
    const to = new Date("2026-04-24T00:00:00Z");

    tool.execute({ from, to });

    expect(deps.deadlineRepo.findByDateRange).toHaveBeenCalledWith(
      from.toISOString(),
      to.toISOString(),
      undefined
    );
  });

  it("returns deadline data as-is from the repo", async () => {
    const dl1 = makeDeadline({ id: "dl-1", description: "Report due" });
    const dl2 = makeDeadline({
      id: "dl-2",
      dueDate: "2026-04-22T12:00:00Z",
      description: "Tax filing",
    });

    const deps = makeDeps({
      deadlineRepo: {
        create: vi.fn(),
        findByInboundItemId: vi.fn(),
        findByDateRange: vi.fn().mockReturnValue([dl1, dl2]),
        findOverdue: vi.fn(),
        updateStatus: vi.fn(),
        count: vi.fn(),
      },
    });

    const tool = createListDeadlinesTool(deps);
    const result = await tool.execute({
      from: new Date("2026-04-17T00:00:00Z"),
      to: new Date("2026-04-24T00:00:00Z"),
    });

    expect(result.data).toEqual([dl1, dl2]);
  });

  it("generates human-readable summary with count and date range", async () => {
    const deps = makeDeps({
      deadlineRepo: {
        create: vi.fn(),
        findByInboundItemId: vi.fn(),
        findByDateRange: vi.fn().mockReturnValue([
          makeDeadline(),
          makeDeadline({ id: "dl-2" }),
          makeDeadline({ id: "dl-3" }),
        ]),
        findOverdue: vi.fn(),
        updateStatus: vi.fn(),
        count: vi.fn(),
      },
    });

    const tool = createListDeadlinesTool(deps);
    const result = await tool.execute({
      from: new Date("2026-04-17T00:00:00Z"),
      to: new Date("2026-04-24T00:00:00Z"),
    });

    expect(result.summary).toContain("3");
    expect(typeof result.summary).toBe("string");
    expect(result.summary.length).toBeGreaterThan(0);
  });

  it("generates singular summary for 1 deadline", async () => {
    const deps = makeDeps({
      deadlineRepo: {
        create: vi.fn(),
        findByInboundItemId: vi.fn(),
        findByDateRange: vi.fn().mockReturnValue([makeDeadline()]),
        findOverdue: vi.fn(),
        updateStatus: vi.fn(),
        count: vi.fn(),
      },
    });

    const tool = createListDeadlinesTool(deps);
    const result = await tool.execute({
      from: new Date("2026-04-17T00:00:00Z"),
      to: new Date("2026-04-24T00:00:00Z"),
    });

    expect(result.summary).toContain("1");
    expect(result.summary).not.toContain("deadlines");
  });

  // ── Integration with registry ──────────────────────────────

  it("can be registered and executed through the ToolRegistry", async () => {
    const deps = makeDeps();
    const tool = createListDeadlinesTool(deps);
    const registry = createToolRegistry();
    registry.register(tool);

    const result = await registry.execute("list_deadlines", {});

    expect(result.data).toEqual([]);
    expect(result.meta.toolName).toBe("list_deadlines");
    expect(result.meta.toolVersion).toBeDefined();
  });
});
