import { describe, it, expect, beforeEach } from "vitest";
import type { NewActionInstance } from "@oneon/domain";
import {
  createListPendingActionsTool,
  listPendingActionsSchema,
} from "./list-pending-actions.js";
import { createToolRegistry } from "./tool-registry.js";
import { InMemoryActionRepo } from "../actions/__tests__/in-memory-repos.js";
import { createActionRegistry } from "../actions/registry.js";
import { createReminderDefinition } from "../actions/definitions/create-reminder.js";
import type { ToolDefinition } from "./tool-registry.js";

// ── Fixtures ─────────────────────────────────────────────────

const clock = () => new Date("2026-10-01T12:00:00Z");

function seed(repo: InMemoryActionRepo, id: string, userId: string, status: "proposed" | "awaiting_approval" | "completed" = "awaiting_approval") {
  const n: NewActionInstance = {
    id,
    scope: "personal",
    ownerId: userId,
    userId,
    tenantId: null,
    locationIds: [],
    actionType: "create_reminder",
    definitionVersion: "1",
    initiator: "system",
    initiatorUserId: null,
    input: { deadlineId: "d1", inboundItemId: "i1" },
    evidence: [],
    idempotencyKey: `key-${id}`,
    retryOf: null,
    attemptNumber: 1,
    resourceRef: "deadline:d1",
  };
  repo.create(n, { kind: "system" });
  if (status === "awaiting_approval") {
    repo.appendTransition({ actionId: id, expectedStatus: "proposed", toStatus: "validating", actor: { kind: "system" } });
    repo.appendTransition({ actionId: id, expectedStatus: "validating", toStatus: "awaiting_approval", actor: { kind: "system" } });
  } else if (status === "completed") {
    repo.instances.get(id)!.status = "completed";
  }
}

describe("listPendingActionsSchema", () => {
  it("defaults to awaiting_approval and limit 20", () => {
    const result = listPendingActionsSchema.parse({});
    expect(result.status).toBe("awaiting_approval");
    expect(result.limit).toBe(20);
  });

  it("accepts every lifecycle status and rejects unknown ones", () => {
    expect(listPendingActionsSchema.parse({ status: "completed" }).status).toBe("completed");
    expect(() => listPendingActionsSchema.parse({ status: "unknown" })).toThrow();
    expect(listPendingActionsSchema.parse({ status: "awaiting_approval" }).status).toBe("awaiting_approval");
  });

  it("bounds limit to 1..50", () => {
    expect(() => listPendingActionsSchema.parse({ limit: 0 })).toThrow();
    expect(() => listPendingActionsSchema.parse({ limit: 51 })).toThrow();
  });
});

describe("list_pending_actions tool", () => {
  let repo: InMemoryActionRepo;
  let tool: ToolDefinition;

  beforeEach(() => {
    repo = new InMemoryActionRepo(clock);
    seed(repo, "a-u1", "u1");
    seed(repo, "a-u2", "u2");
    tool = createListPendingActionsTool({
      instanceRepo: repo,
      registry: createActionRegistry([createReminderDefinition]),
    });
  });

  it("lists the signed-in user's actions awaiting approval", async () => {
    const result = await tool.execute(tool.inputSchema.parse({ userId: "u1" }));
    expect(result.data).toEqual([expect.objectContaining({ id: "a-u1", label: "Create reminder", status: "awaiting_approval" })]);
    expect(result.summary).toBe("Found 1 action awaiting approval.");
  });

  it("never returns another user's actions", async () => {
    const result = await tool.execute(tool.inputSchema.parse({ userId: "u2" }));
    expect((result.data as Array<{ id: string }>).map((a) => a.id)).toEqual(["a-u2"]);
  });

  it("returns nothing without a session", async () => {
    expect((await tool.execute(tool.inputSchema.parse({}))).data).toEqual([]);
  });

  it("filters by an explicit status", async () => {
    seed(repo, "a-done", "u1", "completed");
    const result = await tool.execute(tool.inputSchema.parse({ userId: "u1", status: "completed" }));
    expect((result.data as Array<{ id: string }>).map((a) => a.id)).toEqual(["a-done"]);
    expect(result.summary).toBe("Found 1 action completed.");
  });

  it("works through ToolRegistry async execute", async () => {
    const registry = createToolRegistry();
    registry.register(tool);
    const result = await registry.execute("list_pending_actions", { userId: "u1" });
    expect(result.data).toHaveLength(1);
    expect(result.meta.toolName).toBe("list_pending_actions");
  });
});
