import type { ZodSchema, ZodIssue } from "zod";

// ── Core Types ───────────────────────────────────────────────

export interface ToolResult {
  data: unknown;
  summary: string;
}

export interface ToolExecutionMeta {
  toolName: string;
  toolVersion: string;
  durationMs: number;
  executedAt: Date;
}

export interface ToolExecutionResult {
  data: unknown;
  summary: string;
  meta: ToolExecutionMeta;
}

export interface ToolDefinition {
  name: string;
  version: string;
  description: string;
  inputSchema: ZodSchema;
  execute: (validatedInput: unknown) => ToolResult | Promise<ToolResult>;
}

export interface ToolRegistry {
  register(tool: ToolDefinition): void;
  execute(name: string, rawInput: unknown): Promise<ToolExecutionResult>;
  list(): Array<{ name: string; version: string; description: string }>;
  get(name: string): ToolDefinition | undefined;
  has(name: string): boolean;
}

// ── Error Types ──────────────────────────────────────────────

export class ToolNotFoundError extends Error {
  readonly toolName: string;

  constructor(toolName: string) {
    super(`Tool "${toolName}" not found`);
    this.name = "ToolNotFoundError";
    this.toolName = toolName;
  }
}

export class ToolValidationError extends Error {
  readonly toolName: string;
  readonly issues: ZodIssue[];

  constructor(toolName: string, issues: ZodIssue[]) {
    const details = issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    super(`Tool "${toolName}" input validation failed: ${details}`);
    this.name = "ToolValidationError";
    this.toolName = toolName;
    this.issues = issues;
  }
}

// ── Factory ──────────────────────────────────────────────────

export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, ToolDefinition>();

  function register(tool: ToolDefinition): void {
    if (tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    tools.set(tool.name, tool);
  }

  async function execute(name: string, rawInput: unknown): Promise<ToolExecutionResult> {
    const tool = tools.get(name);
    if (!tool) {
      throw new ToolNotFoundError(name);
    }

    // Centralized validation — tool never sees invalid input
    const parseResult = tool.inputSchema.safeParse(rawInput);
    if (!parseResult.success) {
      throw new ToolValidationError(name, parseResult.error.issues);
    }

    const startTime = performance.now();
    const result = await tool.execute(parseResult.data);
    const durationMs = Math.round((performance.now() - startTime) * 100) / 100;

    return {
      data: result.data,
      summary: result.summary,
      meta: {
        toolName: tool.name,
        toolVersion: tool.version,
        durationMs,
        executedAt: new Date(),
      },
    };
  }

  function list(): Array<{ name: string; version: string; description: string }> {
    return Array.from(tools.values()).map((t) => ({
      name: t.name,
      version: t.version,
      description: t.description,
    }));
  }

  function get(name: string): ToolDefinition | undefined {
    return tools.get(name);
  }

  function has(name: string): boolean {
    return tools.has(name);
  }

  return { register, execute, list, get, has };
}
