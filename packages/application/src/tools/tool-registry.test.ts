import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import {
  createToolRegistry,
  ToolNotFoundError,
  ToolValidationError,
  type ToolDefinition,
} from "./tool-registry.js";

// ── Helpers ──────────────────────────────────────────────────

function makeTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: "test_tool",
    version: "1.0.0",
    description: "A test tool",
    inputSchema: z.object({ query: z.string() }),
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
