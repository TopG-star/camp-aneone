import { describe, it, expect, vi } from "vitest";
import type { LLMPort } from "@oneon/domain";
import { RoutingLlmAdapter } from "./routing-llm.adapter.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeLLM(overrides: Partial<LLMPort> = {}): LLMPort {
  return {
    classify: vi.fn(),
    synthesize: vi.fn(),
    extractIntents: vi.fn(),
    ...overrides,
  };
}

const EMAIL_INPUT = {
  from: "a@b.com",
  subject: "Test",
  bodyPreview: "Hello",
  source: "gmail",
};

const CLASSIFICATION_RESULT = {
  category: "work" as const,
  priority: 2 as const,
  summary: "A test.",
  actionItems: [],
  followUpNeeded: false,
  deadlines: [],
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("RoutingLlmAdapter", () => {
  describe("classify()", () => {
    it("routes classify() to the standard LLM", async () => {
      const standard = makeLLM({ classify: vi.fn().mockResolvedValue(CLASSIFICATION_RESULT) });
      const reasoning = makeLLM();

      const adapter = new RoutingLlmAdapter({ standard, reasoning });
      const result = await adapter.classify(EMAIL_INPUT);

      expect(standard.classify).toHaveBeenCalledWith(EMAIL_INPUT);
      expect(reasoning.classify).not.toHaveBeenCalled();
      expect(result.category).toBe("work");
    });
  });

  describe("synthesize()", () => {
    it("routes synthesize() to the reasoning LLM", async () => {
      const standard = makeLLM();
      const reasoning = makeLLM({ synthesize: vi.fn().mockResolvedValue("premium answer") });

      const adapter = new RoutingLlmAdapter({ standard, reasoning });
      const result = await adapter.synthesize("summarize my day");

      expect(reasoning.synthesize).toHaveBeenCalledWith("summarize my day");
      expect(standard.synthesize).not.toHaveBeenCalled();
      expect(result).toBe("premium answer");
    });
  });

  describe("extractIntents()", () => {
    it("routes extractIntents() to the standard LLM", async () => {
      const intents = [{ tool: "list_deadlines", parameters: {} }];
      const standard = makeLLM({ extractIntents: vi.fn().mockResolvedValue(intents) });
      const reasoning = makeLLM();

      const adapter = new RoutingLlmAdapter({ standard, reasoning });
      const result = await adapter.extractIntents("deadlines?", "ctx");

      expect(standard.extractIntents).toHaveBeenCalledWith("deadlines?", "ctx");
      expect(reasoning.extractIntents).not.toHaveBeenCalled();
      expect(result).toEqual(intents);
    });
  });

  describe("same-instance (no premium routing)", () => {
    it("when standard === reasoning, all calls go to the same adapter", async () => {
      const single = makeLLM({
        classify: vi.fn().mockResolvedValue(CLASSIFICATION_RESULT),
        synthesize: vi.fn().mockResolvedValue("response"),
        extractIntents: vi.fn().mockResolvedValue([]),
      });

      const adapter = new RoutingLlmAdapter({ standard: single, reasoning: single });

      await adapter.classify(EMAIL_INPUT);
      await adapter.synthesize("prompt");
      await adapter.extractIntents("msg", "ctx");

      expect(single.classify).toHaveBeenCalledTimes(1);
      expect(single.synthesize).toHaveBeenCalledTimes(1);
      expect(single.extractIntents).toHaveBeenCalledTimes(1);
    });
  });
});
