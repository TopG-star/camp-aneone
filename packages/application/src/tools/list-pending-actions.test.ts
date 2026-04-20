import { describe, it, expect, vi } from "vitest";
import type { ActionLogEntry } from "@oneon/domain";
import {
  createListPendingActionsTool,
  listPendingActionsSchema,
  type ListPendingActionsDeps,
} from "./list-pending-actions.js";
import { createToolRegistry } from "./tool-registry.js";

// ── Fixtures ─────────────────────────────────────────────────

function makeAction(overrides: Partial<ActionLogEntry> = {}): ActionLogEntry {
  return {
    id: "act-001",
    userId: null,
    resourceId: "item-001",
    actionType: "draft_reply",
    riskLevel: "approval_required",
    status: "proposed",
    payloadJson: JSON.stringify({ to: "alice@example.com" }),
    resultJson: null,
    errorJson: null,
    rollbackJson: null,
    createdAt: "2026-04-17T08:00:00Z",
    updatedAt: "2026-04-17T08:00:00Z",
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<ListPendingActionsDeps> = {}
): ListPendingActionsDeps {
  return {
    actionLogRepo: {
      create: vi.fn(),
      findByResourceAndType: vi.fn().mockReturnValue(null),
      findByStatus: vi.fn().mockReturnValue([]),
      updateStatus: vi.fn(),
      findAll: vi.fn().mockReturnValue([]),
      count: vi.fn().mockReturnValue(0),
    },
    ...overrides,
  };
}

// ── Schema Contract Tests ────────────────────────────────────

describe("listPendingActionsSchema", () => {
  it("accepts empty input with defaults", () => {
    const result = listPendingActionsSchema.parse({});
    expect(result.status).toBe("proposed");
    expect(result.limit).toBe(20);
  });

  it("accepts explicit status filter", () => {
    const result = listPendingActionsSchema.parse({ status: "approved" });
    expect(result.status).toBe("approved");
  });

  it("accepts all valid statuses", () => {
    for (const s of ["proposed", "approved", "executed", "rejected", "rolled_back"]) {
      const result = listPendingActionsSchema.parse({ status: s });
      expect(result.status).toBe(s);
    }
  });

  it("rejects invalid status", () => {
    expect(() => listPendingActionsSchema.parse({ status: "unknown" })).toThrow();
  });

  it("clamps limit to max 100", () => {
    expect(() => listPendingActionsSchema.parse({ limit: 200 })).toThrow();
  });

  it("rejects non-positive limit", () => {
    expect(() => listPendingActionsSchema.parse({ limit: 0 })).toThrow();
    expect(() => listPendingActionsSchema.parse({ limit: -1 })).toThrow();
  });

  it("accepts actionType filter", () => {
    const result = listPendingActionsSchema.parse({ actionType: "draft_reply" });
    expect(result.actionType).toBe("draft_reply");
  });
});

// ── Tool Execution Tests ─────────────────────────────────────

describe("list_pending_actions tool", () => {
  it("returns empty list when no actions match", async () => {
    const deps = makeDeps();
    const tool = createListPendingActionsTool(deps);
    const result = await tool.execute(listPendingActionsSchema.parse({}));

    expect(result.data).toEqual([]);
    expect(result.summary).toBe("Found 0 pending actions.");
    expect(deps.actionLogRepo.findAll).toHaveBeenCalledWith({
      status: "proposed",
      limit: 20,
    });
  });

  it("returns proposed actions by default", async () => {
    const actions = [
      makeAction({ id: "act-001", actionType: "draft_reply" }),
      makeAction({ id: "act-002", actionType: "notify" }),
    ];
    const deps = makeDeps();
    vi.mocked(deps.actionLogRepo.findAll).mockReturnValue(actions);
    const tool = createListPendingActionsTool(deps);

    const result = await tool.execute(listPendingActionsSchema.parse({}));

    expect(result.data).toHaveLength(2);
    expect(result.summary).toBe("Found 2 pending actions.");
  });

  it("filters by explicit status", async () => {
    const deps = makeDeps();
    const tool = createListPendingActionsTool(deps);

    await tool.execute(listPendingActionsSchema.parse({ status: "approved" }));

    expect(deps.actionLogRepo.findAll).toHaveBeenCalledWith({
      status: "approved",
      limit: 20,
    });
  });

  it("filters by actionType when provided", async () => {
    const deps = makeDeps();
    const tool = createListPendingActionsTool(deps);

    await tool.execute(
      listPendingActionsSchema.parse({ actionType: "draft_reply" })
    );

    expect(deps.actionLogRepo.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ actionType: "draft_reply" })
    );
  });

  it("respects limit parameter", async () => {
    const deps = makeDeps();
    const tool = createListPendingActionsTool(deps);

    await tool.execute(listPendingActionsSchema.parse({ limit: 5 }));

    expect(deps.actionLogRepo.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5 })
    );
  });

  it("returns correct summary for single action", async () => {
    const deps = makeDeps();
    vi.mocked(deps.actionLogRepo.findAll).mockReturnValue([makeAction()]);
    const tool = createListPendingActionsTool(deps);

    const result = await tool.execute(listPendingActionsSchema.parse({}));

    expect(result.summary).toBe("Found 1 pending action.");
  });

  it("works through ToolRegistry async execute", async () => {
    const deps = makeDeps();
    vi.mocked(deps.actionLogRepo.findAll).mockReturnValue([makeAction()]);
    const registry = createToolRegistry();
    registry.register(createListPendingActionsTool(deps));

    const result = await registry.execute("list_pending_actions", {});

    expect(result.data).toHaveLength(1);
    expect(result.meta.toolName).toBe("list_pending_actions");
    expect(result.meta.durationMs).toBeGreaterThanOrEqual(0);
  });
});
