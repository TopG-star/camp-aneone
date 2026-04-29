import { describe, it, expect, vi } from "vitest";
import {
  buildSynthesisPrompt,
  synthesisResponseSchema,
  synthesizeResponse,
  extractJsonFromText,
  SYNTHESIS_PROMPT_VERSION,
  type BuildSynthesisPromptInput,
} from "./synthesize-response.js";
import type { SynthesisPort, ConversationMessage, Logger } from "@oneon/domain";
import type { ToolCallRecord } from "./build-chat-context.js";

// ── Helpers ──────────────────────────────────────────────────

function createMockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeMessage(
  role: "user" | "assistant",
  content: string
): ConversationMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 6)}`,
    userId: null,
    conversationId: "conv-1",
    role,
    content,
    toolCalls: null,
    createdAt: "2026-04-17T07:55:00Z",
  };
}

function makeToolCall(
  tool: string,
  summary: string,
  overrides: Partial<ToolCallRecord> = {}
): ToolCallRecord {
  return {
    id: `tc-${Math.random().toString(36).slice(2, 6)}`,
    round: 1,
    tool,
    parameters: {},
    result: { data: {}, summary },
    error: null,
    durationMs: 10,
    executedAt: "2026-04-17T08:00:01Z",
    ...overrides,
  };
}

function defaultPromptInput(
  overrides: Partial<BuildSynthesisPromptInput> = {}
): BuildSynthesisPromptInput {
  return {
    userMessage: "What are my deadlines?",
    toolCalls: [
      makeToolCall("list_deadlines", "Found 3 deadlines due this week"),
    ],
    history: [],
    ...overrides,
  };
}

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

// ── extractJsonFromText ──────────────────────────────────────

describe("extractJsonFromText", () => {
  it("parses clean JSON string", () => {
    const json = '{"answer":"hello","usedTools":["t1"]}';
    expect(extractJsonFromText(json)).toEqual({
      answer: "hello",
      usedTools: ["t1"],
    });
  });

  it("extracts JSON from markdown code fence", () => {
    const text = 'Some preamble\n```json\n{"answer":"hello","usedTools":[]}\n```\ntrailing';
    expect(extractJsonFromText(text)).toEqual({
      answer: "hello",
      usedTools: [],
    });
  });

  it("extracts first JSON object from mixed text", () => {
    const text = 'Here is my response: {"answer":"ok","usedTools":["a"]} hope that helps';
    expect(extractJsonFromText(text)).toEqual({
      answer: "ok",
      usedTools: ["a"],
    });
  });

  it("returns null for non-JSON text", () => {
    expect(extractJsonFromText("just some plain text")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(extractJsonFromText("{broken json")).toBeNull();
  });
});

// ── buildSynthesisPrompt ─────────────────────────────────────

describe("buildSynthesisPrompt", () => {
  it("includes promptVersion in the prompt", () => {
    const prompt = buildSynthesisPrompt(defaultPromptInput());
    expect(prompt).toContain(SYNTHESIS_PROMPT_VERSION);
  });

  it("includes JSON-only output instruction", () => {
    const prompt = buildSynthesisPrompt(defaultPromptInput());
    expect(prompt).toContain("Return ONLY valid JSON");
  });

  it("includes the response schema shape in the prompt", () => {
    const prompt = buildSynthesisPrompt(defaultPromptInput());
    expect(prompt).toContain('"answer"');
    expect(prompt).toContain('"usedTools"');
    expect(prompt).toContain('"followUps"');
    expect(prompt).toContain('"warnings"');
  });

  it("includes the user message", () => {
    const prompt = buildSynthesisPrompt(
      defaultPromptInput({ userMessage: "Show me urgent items" })
    );
    expect(prompt).toContain("Show me urgent items");
  });

  it("includes tool summaries (not data blobs)", () => {
    const prompt = buildSynthesisPrompt(
      defaultPromptInput({
        toolCalls: [
          makeToolCall("list_deadlines", "Found 3 deadlines"),
          makeToolCall("search_emails", "5 emails matched"),
        ],
      })
    );
    expect(prompt).toContain("[list_deadlines]: Found 3 deadlines");
    expect(prompt).toContain("[search_emails]: 5 emails matched");
    // Should NOT contain raw data
    expect(prompt).not.toContain('"data"');
  });

  it("skips failed tool calls from summaries", () => {
    const prompt = buildSynthesisPrompt(
      defaultPromptInput({
        toolCalls: [
          makeToolCall("list_deadlines", "Found 3", {}),
          makeToolCall("search_emails", "", { result: null, error: "timeout" }),
        ],
      })
    );
    expect(prompt).toContain("[list_deadlines]");
    expect(prompt).not.toContain("[search_emails]");
  });

  it("includes conversation history when provided", () => {
    const prompt = buildSynthesisPrompt(
      defaultPromptInput({
        history: [
          makeMessage("user", "Previous question"),
          makeMessage("assistant", "Previous answer"),
        ],
      })
    );
    expect(prompt).toContain("[user]: Previous question");
    expect(prompt).toContain("[assistant]: Previous answer");
  });

  it("omits history section when no history", () => {
    const prompt = buildSynthesisPrompt(
      defaultPromptInput({ history: [] })
    );
    // Should not have CONVERSATION CONTEXT header with empty content
    expect(prompt).not.toContain("[user]:");
    expect(prompt).not.toContain("[assistant]:");
  });

  it("notes failed tools as warnings context", () => {
    const prompt = buildSynthesisPrompt(
      defaultPromptInput({
        toolCalls: [
          makeToolCall("list_deadlines", "", { result: null, error: "DB down" }),
        ],
      })
    );
    expect(prompt).toContain("list_deadlines");
    expect(prompt).toContain("failed");
  });

  it("includes grounding rules", () => {
    const prompt = buildSynthesisPrompt(defaultPromptInput());
    expect(prompt).toContain("ONLY from the tool results");
    expect(prompt).toContain("Do not hallucinate");
  });

  it("includes user personalization block when persona is provided", () => {
    const prompt = buildSynthesisPrompt(
      {
        ...defaultPromptInput(),
        // Cast here so we can drive RED first before adding persona type support.
        persona: {
          preferredName: "Adewale",
          nickname: "Wale",
          salutationMode: "sir_with_name",
          communicationStyle: "technical",
        },
      } as BuildSynthesisPromptInput,
    );

    expect(prompt).toContain("[USER PREFERENCES]");
    expect(prompt).toContain("Address the user as: Sir Adewale");
    expect(prompt).toContain("Communication style: technical");
  });
});

// ── synthesizeResponse ───────────────────────────────────────

describe("synthesizeResponse", () => {
  function createMockSynthesizer(response: string): SynthesisPort {
    return { synthesize: vi.fn(async () => response) };
  }

  const baseInput = {
    userMessage: "What deadlines?",
    toolCalls: [makeToolCall("list_deadlines", "3 deadlines")],
    history: [] as ConversationMessage[],
  };

  it("returns structured response on valid JSON from LLM", async () => {
    const llmResponse = JSON.stringify({
      answer: "You have 3 deadlines.",
      usedTools: ["list_deadlines"],
      followUps: ["Show details"],
    });
    const synthesizer = createMockSynthesizer(llmResponse);
    const result = await synthesizeResponse(
      { synthesizer, logger: createMockLogger() },
      baseInput
    );

    expect(result.response.answer).toBe("You have 3 deadlines.");
    expect(result.response.usedTools).toEqual(["list_deadlines"]);
    expect(result.response.followUps).toEqual(["Show details"]);
    expect(result.response.warnings).toEqual([]);
  });

  it("extracts JSON from code-fenced LLM response", async () => {
    const llmResponse =
      '```json\n{"answer":"hello","usedTools":["t1"]}\n```';
    const synthesizer = createMockSynthesizer(llmResponse);
    const result = await synthesizeResponse(
      { synthesizer, logger: createMockLogger() },
      baseInput
    );

    expect(result.response.answer).toBe("hello");
  });

  it("falls back to raw text when LLM returns non-JSON", async () => {
    const synthesizer = createMockSynthesizer(
      "You have 3 deadlines this week."
    );
    const logger = createMockLogger();
    const result = await synthesizeResponse(
      { synthesizer, logger },
      baseInput
    );

    expect(result.response.answer).toBe("You have 3 deadlines this week.");
    expect(result.response.usedTools).toEqual(["list_deadlines"]);
    expect(result.response.warnings).toContain("Response was not structured JSON");
    expect(logger.warn).toHaveBeenCalled();
  });

  it("falls back to raw text when JSON fails schema validation", async () => {
    const synthesizer = createMockSynthesizer(
      '{"answer":"","usedTools":[]}' // empty answer fails min(1)
    );
    const logger = createMockLogger();
    const result = await synthesizeResponse(
      { synthesizer, logger },
      baseInput
    );

    // Falls back to the raw text answer since empty answer fails schema
    expect(result.response.answer).toBe('{"answer":"","usedTools":[]}');
    expect(result.response.warnings).toContain("Response was not structured JSON");
  });

  it("includes promptVersion and model in meta", async () => {
    const llmResponse = JSON.stringify({
      answer: "ok",
      usedTools: [],
    });
    const synthesizer = createMockSynthesizer(llmResponse);
    const result = await synthesizeResponse(
      { synthesizer, logger: createMockLogger() },
      baseInput
    );

    expect(result.meta.promptVersion).toBe(SYNTHESIS_PROMPT_VERSION);
    expect(typeof result.meta.durationMs).toBe("number");
    expect(typeof result.meta.promptChars).toBe("number");
    expect(typeof result.meta.rawResponseChars).toBe("number");
  });

  it("throws when synthesizer throws", async () => {
    const synthesizer: SynthesisPort = {
      synthesize: vi.fn(async () => {
        throw new Error("LLM down");
      }),
    };
    await expect(
      synthesizeResponse(
        { synthesizer, logger: createMockLogger() },
        baseInput
      )
    ).rejects.toThrow("LLM down");
  });
});
