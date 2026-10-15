import type { ZodSchema, ZodIssue } from "zod";
import type { ActionInstanceRepository } from "@oneon/domain";
import type { ActionRegistry } from "../actions/registry.js";
import type { ToolOutputSchema } from "./output-schema.js";

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

/** The context a chat runs in (spec 9.5). A tool is offered, and may run, only in the contexts it declares. */
export type ToolContextKind = "personal" | "tenant";

/**
 * What a tool running in a tenant context may use, all belonging to that request: built by the server from the active
 * context, never from model output or request input. A personal run has no scope.
 */
export interface TenantToolScope {
  identityId: string;
  /** The registry tenant id the tenant file's rows carry; it owns the tenant's action instances. */
  tenantId: string;
  membershipId: string;
  /** The action instances and definitions of this request's own tenant file. */
  actions: { instanceRepo: ActionInstanceRepository; registry: ActionRegistry };
}

export interface ToolDefinition {
  name: string;
  version: string;
  description: string;
  /** Where the tool is offered and may run. Declare it explicitly; a tool that does not is personal only. */
  contexts?: ReadonlyArray<ToolContextKind>;
  inputSchema: ZodSchema;
  output: ToolOutputSchema;
  /** `scope` is given only when the tool runs in a tenant context. */
  execute: (validatedInput: unknown, scope?: TenantToolScope) => ToolResult | Promise<ToolResult>;
}

/** A tool refused because it is not available in the context the call names. Nothing ran. */
export interface ToolRefusal {
  ok: false;
  error: "tool_not_in_context";
}

export interface ToolRegistry {
  register(tool: ToolDefinition): void;
  /**
   * Without a context the call is a personal one: a tool outside it throws ToolNotFoundError, as an unknown tool does.
   * With a context, a tool outside it is refused with `tool_not_in_context` before its input is looked at.
   * A tenant call must carry the tenant scope; without it the call throws, so a tool never falls back to personal data.
   */
  execute(name: string, rawInput: unknown): Promise<ToolExecutionResult>;
  execute(name: string, rawInput: unknown, kind: "personal"): Promise<ToolExecutionResult | ToolRefusal>;
  execute(name: string, rawInput: unknown, kind: "tenant", scope: TenantToolScope): Promise<ToolExecutionResult | ToolRefusal>;
  list(): Array<{ name: string; version: string; description: string }>;
  /** The tools offered in a context. */
  listFor(kind: ToolContextKind): Array<{ name: string; version: string; description: string }>;
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

const DEFAULT_CONTEXTS: ReadonlyArray<ToolContextKind> = ["personal"];

export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, ToolDefinition>();
  const availableIn = (tool: ToolDefinition, kind: ToolContextKind): boolean => (tool.contexts ?? DEFAULT_CONTEXTS).includes(kind);

  function register(tool: ToolDefinition): void {
    if (tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    tools.set(tool.name, tool);
  }

  async function execute(name: string, rawInput: unknown): Promise<ToolExecutionResult>;
  async function execute(name: string, rawInput: unknown, kind: "personal"): Promise<ToolExecutionResult | ToolRefusal>;
  async function execute(name: string, rawInput: unknown, kind: "tenant", scope: TenantToolScope): Promise<ToolExecutionResult | ToolRefusal>;
  async function execute(name: string, rawInput: unknown, kind?: ToolContextKind, scope?: TenantToolScope): Promise<ToolExecutionResult | ToolRefusal> {
    if (kind === "tenant" && !scope) throw new Error("A tenant tool call needs the tenant scope");
    const tool = tools.get(name);
    if (!tool) {
      throw new ToolNotFoundError(name);
    }
    if (!availableIn(tool, kind ?? "personal")) {
      if (kind === undefined) throw new ToolNotFoundError(name);
      return { ok: false, error: "tool_not_in_context" };
    }

    // Centralized validation — tool never sees invalid input
    const parseResult = tool.inputSchema.safeParse(rawInput);
    if (!parseResult.success) {
      throw new ToolValidationError(name, parseResult.error.issues);
    }

    const startTime = performance.now();
    // A personal run passes no scope, so a tool sees exactly the one argument it always did.
    const result = await (scope ? tool.execute(parseResult.data, scope) : tool.execute(parseResult.data));
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

  function listFor(kind: ToolContextKind): Array<{ name: string; version: string; description: string }> {
    return Array.from(tools.values())
      .filter((t) => availableIn(t, kind))
      .map((t) => ({ name: t.name, version: t.version, description: t.description }));
  }

  function get(name: string): ToolDefinition | undefined {
    return tools.get(name);
  }

  function has(name: string): boolean {
    return tools.has(name);
  }

  return { register, execute, list, listFor, get, has };
}
