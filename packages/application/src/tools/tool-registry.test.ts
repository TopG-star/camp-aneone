import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import {
  createToolRegistry,
  ToolNotFoundError,
  ToolValidationError,
  type TenantToolScope,
  type ToolDefinition,
} from "./tool-registry.js";
import * as toolModule from "./index.js";
import { createShowMyAccessTool } from "./show-my-access.js";
import { createListPendingActionsTool } from "./list-pending-actions.js";
import { createChatActionTools } from "../actions/chat-action-tools.js";
import { createActionRegistry } from "../actions/registry.js";
import { createReminderDefinition } from "../actions/definitions/create-reminder.js";
import { InMemoryActionRepo } from "../actions/__tests__/in-memory-repos.js";

// ── Helpers ──────────────────────────────────────────────────

function makeTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: "test_tool",
    version: "1.0.0",
    description: "A test tool",
    inputSchema: z.object({ query: z.string() }),
    output: { fields: {}, summaryClass: "D1" },
    execute: () => ({ data: { items: [] }, summary: "No items found" }),
    ...overrides,
  };
}

// ── Behavioral Tests ─────────────────────────────────────────

describe("ToolRegistry", () => {
  // ── register + list ──────────────────────────────────────

  it("registers a tool and lists it", () => {
    const registry = createToolRegistry();
    registry.register(makeTool());

    const tools = registry.list();
    expect(tools).toEqual([
      { name: "test_tool", version: "1.0.0", description: "A test tool" },
    ]);
  });

  it("registers multiple tools and lists them all", () => {
    const registry = createToolRegistry();
    registry.register(makeTool({ name: "tool_a", description: "Tool A" }));
    registry.register(makeTool({ name: "tool_b", description: "Tool B" }));

    expect(registry.list()).toHaveLength(2);
    expect(registry.list().map((t) => t.name)).toEqual(["tool_a", "tool_b"]);
  });

  it("throws when registering a duplicate tool name", () => {
    const registry = createToolRegistry();
    registry.register(makeTool());

    expect(() => registry.register(makeTool())).toThrow(
      'Tool "test_tool" is already registered'
    );
  });

  // ── get + has ────────────────────────────────────────────

  it("returns a tool definition by name", () => {
    const registry = createToolRegistry();
    const tool = makeTool();
    registry.register(tool);

    expect(registry.get("test_tool")).toBe(tool);
  });

  it("returns undefined for unknown tool", () => {
    const registry = createToolRegistry();
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("returns true for a registered tool", () => {
    const registry = createToolRegistry();
    registry.register(makeTool());
    expect(registry.has("test_tool")).toBe(true);
  });

  it("returns false for an unregistered tool", () => {
    const registry = createToolRegistry();
    expect(registry.has("nonexistent")).toBe(false);
  });

  // ── execute: validation ──────────────────────────────────

  it("throws ToolNotFoundError for unknown tool name", async () => {
    const registry = createToolRegistry();

    await expect(registry.execute("ghost_tool", {})).rejects.toThrow(
      ToolNotFoundError
    );
    await expect(registry.execute("ghost_tool", {})).rejects.toThrow(
      'Tool "ghost_tool" not found'
    );
  });

  it("throws ToolValidationError when input fails schema", async () => {
    const registry = createToolRegistry();
    registry.register(
      makeTool({
        inputSchema: z.object({ query: z.string().min(1) }),
      })
    );

    await expect(registry.execute("test_tool", { query: "" })).rejects.toThrow(
      ToolValidationError
    );
  });

  it("includes field-level details in ToolValidationError", async () => {
    const registry = createToolRegistry();
    registry.register(
      makeTool({
        inputSchema: z.object({ query: z.string(), limit: z.number() }),
      })
    );

    try {
      await registry.execute("test_tool", { query: 123, limit: "bad" });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolValidationError);
      expect((e as ToolValidationError).toolName).toBe("test_tool");
      expect((e as ToolValidationError).issues).toBeInstanceOf(Array);
      expect((e as ToolValidationError).issues.length).toBeGreaterThan(0);
    }
  });

  // ── execute: success path ────────────────────────────────

  it("passes validated input to the tool execute function", async () => {
    const executeFn = vi.fn().mockReturnValue({
      data: [{ id: "1" }],
      summary: "Found 1 item",
    });
    const registry = createToolRegistry();
    registry.register(makeTool({ execute: executeFn }));

    await registry.execute("test_tool", { query: "urgent" });

    expect(executeFn).toHaveBeenCalledWith({ query: "urgent" });
  });

  it("returns ToolExecutionResult with data, summary, and meta", async () => {
    const registry = createToolRegistry();
    registry.register(
      makeTool({
        execute: () => ({
          data: { items: [1, 2, 3] },
          summary: "Found 3 items",
        }),
      })
    );

    const result = await registry.execute("test_tool", { query: "test" });

    expect(result.data).toEqual({ items: [1, 2, 3] });
    expect(result.summary).toBe("Found 3 items");
    expect(result.meta.toolName).toBe("test_tool");
    expect(result.meta.toolVersion).toBe("1.0.0");
    expect(result.meta.executedAt).toBeInstanceOf(Date);
    expect(typeof result.meta.durationMs).toBe("number");
    expect(result.meta.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("applies Zod defaults/coercion before passing to execute", async () => {
    const executeFn = vi.fn().mockReturnValue({
      data: null,
      summary: "ok",
    });
    const registry = createToolRegistry();
    registry.register(
      makeTool({
        inputSchema: z.object({
          query: z.string(),
          limit: z.number().default(10),
        }),
        execute: executeFn,
      })
    );

    await registry.execute("test_tool", { query: "test" });

    // The default should have been applied by Zod before reaching execute
    expect(executeFn).toHaveBeenCalledWith({ query: "test", limit: 10 });
  });

  it("propagates errors from tool execute as-is (not wrapped)", async () => {
    const registry = createToolRegistry();
    registry.register(
      makeTool({
        execute: () => {
          throw new Error("DB connection lost");
        },
      })
    );

    await expect(registry.execute("test_tool", { query: "x" })).rejects.toThrow(
      "DB connection lost"
    );
  });

  // ── Contract Tests ─────────────────────────────────────────

  describe("ToolDefinition contract", () => {
    it("registered tool exposes name, version, description, inputSchema, execute", () => {
      const registry = createToolRegistry();
      const tool = makeTool();
      registry.register(tool);

      const retrieved = registry.get("test_tool")!;
      expect(typeof retrieved.name).toBe("string");
      expect(retrieved.name.length).toBeGreaterThan(0);
      expect(typeof retrieved.version).toBe("string");
      expect(retrieved.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(typeof retrieved.description).toBe("string");
      expect(retrieved.description.length).toBeGreaterThan(0);
      expect(retrieved.inputSchema).toBeDefined();
      expect(typeof retrieved.inputSchema.parse).toBe("function");
      expect(typeof retrieved.execute).toBe("function");
    });
  });

  describe("ToolResult contract", () => {
    it("execute always returns { data, summary } with non-empty summary", async () => {
      const registry = createToolRegistry();
      registry.register(makeTool());

      const result = await registry.execute("test_tool", { query: "x" });

      expect(result).toHaveProperty("data");
      expect(result).toHaveProperty("summary");
      expect(typeof result.summary).toBe("string");
      expect(result.summary.length).toBeGreaterThan(0);
    });
  });

  describe("ToolExecutionResult meta contract", () => {
    it("meta always contains toolName, toolVersion, durationMs, executedAt", async () => {
      const registry = createToolRegistry();
      registry.register(makeTool());

      const result = await registry.execute("test_tool", { query: "x" });

      expect(result.meta).toEqual(
        expect.objectContaining({
          toolName: expect.any(String),
          toolVersion: expect.any(String),
          durationMs: expect.any(Number),
          executedAt: expect.any(Date),
        })
      );
    });
  });
});

// ── Contexts ─────────────────────────────────────────────────

describe("ToolRegistry contexts", () => {
  const actionRegistry = createActionRegistry([createReminderDefinition]);
  const actionInstances = new InMemoryActionRepo(() => new Date("2026-10-08T10:00:00Z"));
  const scope: TenantToolScope = {
    identityId: "i1",
    tenantId: "t1",
    membershipId: "m1",
    actions: { instanceRepo: actionInstances, registry: actionRegistry },
  };
  const membership = { identityId: "i1", status: "active", role: "Admin", permissions: ["inventory.view"], locationIds: ["l1"], snapshotAt: "2026-10-08T09:00:00.000Z" };
  const chatActionDeps = { requestAction: vi.fn(), registry: actionRegistry, aiModel: "test", clock: () => new Date() };
  /** The factories the server registers from. Each is built with empty deps: building a definition never reads them. */
  const factoryTools = (): ToolDefinition[] =>
    Object.entries(toolModule)
      .filter(([name, value]) => /^create\w+Tool$/.test(name) && typeof value === "function")
      .map(([, factory]) => (factory as (deps: unknown) => ToolDefinition)({}));

  function fullRegistry() {
    const registry = createToolRegistry();
    registry.register(makeTool({ name: "list_inbox", contexts: ["personal"] }));
    registry.register(makeTool({ name: "no_declaration" }));
    registry.register(createListPendingActionsTool({ instanceRepo: actionInstances, registry: actionRegistry }));
    registry.register(createShowMyAccessTool({ memberships: { findById: () => membership } }));
    return registry;
  }

  it('listFor("tenant") contains only show_my_access and list_pending_actions', () => {
    expect(fullRegistry().listFor("tenant").map((t) => t.name).sort()).toEqual(["list_pending_actions", "show_my_access"]);
  });

  it('listFor("personal") offers the personal tools and the shared one, never a tenant-only tool', () => {
    expect(fullRegistry().listFor("personal").map((t) => t.name)).toEqual(["list_inbox", "no_declaration", "list_pending_actions"]);
  });

  it("list() still describes every registered tool", () => {
    expect(fullRegistry().list().map((t) => t.name)).toHaveLength(4);
  });

  it("executing a personal tool in a tenant context returns tool_not_in_context", async () => {
    const executeFn = vi.fn().mockReturnValue({ data: [], summary: "ok" });
    const registry = createToolRegistry();
    registry.register(makeTool({ name: "list_inbox", contexts: ["personal"], inputSchema: z.object({}), execute: executeFn }));

    const result = await registry.execute("list_inbox", {}, "tenant", scope);

    expect(result).toEqual({ ok: false, error: "tool_not_in_context" });
    expect(executeFn).not.toHaveBeenCalled();
  });

  it("a tool with no declaration is refused in a tenant context", async () => {
    const registry = createToolRegistry();
    registry.register(makeTool({ name: "no_declaration", inputSchema: z.object({}) }));

    expect(await registry.execute("no_declaration", {}, "tenant", scope)).toEqual({ ok: false, error: "tool_not_in_context" });
  });

  it("a refusal comes before input validation, so it says nothing about the tool's input", async () => {
    const registry = createToolRegistry();
    registry.register(makeTool({ name: "list_inbox", contexts: ["personal"] }));

    expect(await registry.execute("list_inbox", { query: 42 }, "tenant", scope)).toEqual({ ok: false, error: "tool_not_in_context" });
  });

  it("a tenant tool runs in a tenant context and receives the scope", async () => {
    const executeFn = vi.fn().mockReturnValue({ data: null, summary: "ok" });
    const registry = createToolRegistry();
    registry.register(makeTool({ name: "show_my_access", contexts: ["tenant"], inputSchema: z.object({}), execute: executeFn }));

    const result = await registry.execute("show_my_access", {}, "tenant", scope);

    expect(result).toMatchObject({ summary: "ok", meta: { toolName: "show_my_access" } });
    expect(executeFn).toHaveBeenCalledWith({}, scope);
  });

  it("a tenant call without the tenant scope throws, so no tool can fall back to personal data", async () => {
    const executeFn = vi.fn().mockReturnValue({ data: [], summary: "ok" });
    const registry = createToolRegistry();
    registry.register(makeTool({ name: "list_pending_actions", contexts: ["personal", "tenant"], inputSchema: z.object({}), execute: executeFn }));

    const untyped = registry.execute as (name: string, input: unknown, kind: string) => Promise<unknown>;
    await expect(untyped("list_pending_actions", {}, "tenant")).rejects.toThrow("A tenant tool call needs the tenant scope");
    expect(executeFn).not.toHaveBeenCalled();
  });

  it("a call naming no context is a personal call: a tenant-only tool is not found", async () => {
    const registry = createToolRegistry();
    registry.register(makeTool({ name: "show_my_access", contexts: ["tenant"], inputSchema: z.object({}) }));

    await expect(registry.execute("show_my_access", {})).rejects.toThrow(ToolNotFoundError);
    expect(await registry.execute("show_my_access", {}, "personal")).toEqual({ ok: false, error: "tool_not_in_context" });
  });

  it("every registered tool declares contexts explicitly", () => {
    const definitions = [...factoryTools(), ...createChatActionTools(chatActionDeps)];

    expect(factoryTools().length).toBeGreaterThanOrEqual(19);
    const undeclared = definitions.filter((t) => !Array.isArray(t.contexts) || t.contexts.length === 0).map((t) => t.name);
    expect(undeclared).toEqual([]);
  });

  it("with every real tool registered, a tenant context is offered only list_pending_actions and show_my_access", () => {
    const registry = createToolRegistry();
    for (const tool of [...factoryTools(), ...createChatActionTools(chatActionDeps)]) registry.register(tool);

    expect(registry.listFor("tenant").map((t) => t.name).sort()).toEqual(["list_pending_actions", "show_my_access"]);
    expect(registry.listFor("personal").map((t) => t.name)).not.toContain("show_my_access");
  });
});
