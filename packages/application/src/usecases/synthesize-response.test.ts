import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import type { ConversationMessage, Logger } from "@oneon/domain";
import { synthesisResponseSchema, synthesizeResponse, DATA_WITHHELD_NOTE } from "./synthesize-response.js";
import type { ToolCallRecord } from "../ai-boundary/requests/chat.js";
import { createToolRegistry } from "../tools/tool-registry.js";
import type { GatewayResult } from "../ai-boundary/gateway.js";
import type { WithheldItem } from "../ai-boundary/decide.js";
import { answered, blocked, denied, stubGateway } from "../ai-boundary/__tests__/stub-gateway.js";

// ── Helpers ──────────────────────────────────────────────────

function createMockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeToolCall(tool: string, summary: string): ToolCallRecord {
  return {
    id: "tc-1",
    round: 1,
    tool,
    parameters: {},
    result: { data: {}, summary },
    error: null,
    durationMs: 10,
    executedAt: "2026-04-17T08:00:01Z",
  };
}

const registry = createToolRegistry();
registry.register({
  name: "list_deadlines",
  version: "1",
  description: "d",
  inputSchema: z.object({}),
  output: { fields: {}, summaryClass: "D1" },
  execute: () => ({ data: {}, summary: "" }),
});

const turnFor = (result: GatewayResult) =>
  stubGateway({ respond: () => result }).beginTurn({ kind: "personal", identityId: "u1" });

const baseInput = {
  userMessage: "What deadlines?",
  toolCalls: [makeToolCall("list_deadlines", "3 deadlines")],
  history: [] as ConversationMessage[],
  persona: null,
  registry,
};

// ── synthesisResponseSchema ──────────────────────────────────

describe("synthesisResponseSchema", () => {
  it("accepts minimal valid response (answer + usedTools)", () => {
    const result = synthesisResponseSchema.safeParse({
      answer: "You have 3 deadlines.",
      usedTools: ["list_deadlines"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts full response with all optional fields", () => {
    const result = synthesisResponseSchema.safeParse({
      answer: "You have 3 deadlines.",
      followUps: ["Show me the details", "Mark one as done"],
      usedTools: ["list_deadlines", "search_emails"],
      warnings: ["Some results may be outdated"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.followUps).toHaveLength(2);
      expect(result.data.warnings).toHaveLength(1);
    }
  });

  it("defaults followUps and warnings to empty arrays", () => {
    const result = synthesisResponseSchema.safeParse({
      answer: "ok",
      usedTools: [],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.followUps).toEqual([]);
      expect(result.data.warnings).toEqual([]);
    }
  });

  it("rejects missing answer", () => {
    const result = synthesisResponseSchema.safeParse({
      usedTools: ["list_deadlines"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing usedTools", () => {
    const result = synthesisResponseSchema.safeParse({
      answer: "ok",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty answer", () => {
    const result = synthesisResponseSchema.safeParse({
      answer: "",
      usedTools: [],
    });
    expect(result.success).toBe(false);
  });
});

// ── synthesizeResponse ───────────────────────────────────────

describe("synthesizeResponse", () => {
  const reply = { answer: "You have 3 deadlines.", usedTools: ["list_deadlines"], followUps: ["Show details"], warnings: [] };

  it("returns the structured answer on an answered result", async () => {
    const result = await synthesizeResponse({ modelTurn: turnFor(answered(reply)), logger: createMockLogger() }, baseInput);
    expect(result).toEqual({ kind: "answered", response: reply, dataWithheld: false });
  });

  it("sends a chat_reply request through the turn", async () => {
    const gateway = stubGateway({ respond: () => answered(reply) });
    await synthesizeResponse({ modelTurn: gateway.beginTurn({ kind: "personal", identityId: "u1" }), logger: createMockLogger() }, baseInput);
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0].purpose).toBe("chat_reply");
  });

  it("reports data withheld when a tool record was withheld", async () => {
    const withheld: WithheldItem[] = [{ part: "record:tool:list_deadlines", field: "x", reason: "above_limit" }];
    const result = await synthesizeResponse(
      { modelTurn: turnFor({ ...answered(reply), withheld }), logger: createMockLogger() },
      baseInput,
    );
    expect(result).toMatchObject({ kind: "answered", dataWithheld: true });
  });

  it("does not report data withheld when only history was withheld", async () => {
    const withheld: WithheldItem[] = [{ part: "history", reason: "above_limit" }];
    const result = await synthesizeResponse(
      { modelTurn: turnFor({ ...answered(reply), withheld }), logger: createMockLogger() },
      baseInput,
    );
    expect(result).toMatchObject({ kind: "answered", dataWithheld: false });
  });

  it("is unavailable and flags withheld data when the gateway denies the reply", async () => {
    const logger = createMockLogger();
    const result = await synthesizeResponse({ modelTurn: turnFor(denied("required_part_withheld")), logger }, baseInput);
    expect(result).toEqual({ kind: "unavailable", reason: "denied", dataWithheld: true });
    expect(logger.warn).toHaveBeenCalledWith("Chat reply unavailable", { kind: "denied" });
  });

  it("is unavailable, without the withheld flag, when the answer is blocked", async () => {
    const result = await synthesizeResponse({ modelTurn: turnFor(blocked("invalid_output")), logger: createMockLogger() }, baseInput);
    expect(result).toEqual({ kind: "unavailable", reason: "blocked", dataWithheld: false });
  });

  it("exposes the withheld note text", () => {
    expect(DATA_WITHHELD_NOTE).toBe("Some details weren't shared with the AI under your AI data settings.");
  });
});
