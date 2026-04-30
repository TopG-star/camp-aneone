import { describe, it, expect, vi } from "vitest";
import type { LLMPort, Logger } from "@oneon/domain";
import { ShadowLlmAdapter } from "./shadow-llm.adapter.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeLLM(overrides: Partial<LLMPort> = {}): LLMPort {
  return {
    classify: vi.fn(),
    synthesize: vi.fn(),
    extractIntents: vi.fn(),
    ...overrides,
  };
}

const logger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const EMAIL_INPUT = {
  from: "a@b.com",
  subject: "Test",
  bodyPreview: "Hello",
  source: "gmail",
};

const CLASSIFICATION_RESULT = {
  category: "work" as const,
  priority: 2 as const,
  summary: "A test email.",
  actionItems: [],
  followUpNeeded: false,
  deadlines: [],
};

// Allow unhandled promise rejections from fire-and-forget to settle
function flushPromises() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ShadowLlmAdapter", () => {
  describe("classify()", () => {
    it("returns the primary result, not the shadow result", async () => {
      const primary = makeLLM({ classify: vi.fn().mockResolvedValue(CLASSIFICATION_RESULT) });
      const shadow = makeLLM({ classify: vi.fn().mockResolvedValue({ ...CLASSIFICATION_RESULT, category: "urgent" as const }) });

      const adapter = new ShadowLlmAdapter({ primary, shadow, logger });
      const result = await adapter.classify(EMAIL_INPUT);

      expect(result.category).toBe("work");
    });

    it("calls both primary and shadow with the same input", async () => {
      const primary = makeLLM({ classify: vi.fn().mockResolvedValue(CLASSIFICATION_RESULT) });
      const shadow = makeLLM({ classify: vi.fn().mockResolvedValue(CLASSIFICATION_RESULT) });

      const adapter = new ShadowLlmAdapter({ primary, shadow, logger });
      await adapter.classify(EMAIL_INPUT);
      await flushPromises();

      expect(primary.classify).toHaveBeenCalledWith(EMAIL_INPUT);
      expect(shadow.classify).toHaveBeenCalledWith(EMAIL_INPUT);
    });

    it("shadow call is fire-and-forget: primary result is returned even if shadow is slow", async () => {
      const primary = makeLLM({ classify: vi.fn().mockResolvedValue(CLASSIFICATION_RESULT) });
      let shadowResolve!: () => void;
      const shadowPromise = new Promise<typeof CLASSIFICATION_RESULT>((res) => { shadowResolve = () => res(CLASSIFICATION_RESULT); });
      const shadow = makeLLM({ classify: vi.fn().mockReturnValue(shadowPromise) });

      const adapter = new ShadowLlmAdapter({ primary, shadow, logger });
      const result = await adapter.classify(EMAIL_INPUT);

      // primary resolves immediately; shadow is still pending
      expect(result.category).toBe("work");
      shadowResolve(); // clean up
    });

    it("logs warn on shadow error, does NOT throw", async () => {
      const warnSpy = vi.fn();
      const testLogger: Logger = { ...logger, warn: warnSpy };
      const primary = makeLLM({ classify: vi.fn().mockResolvedValue(CLASSIFICATION_RESULT) });
      const shadow = makeLLM({ classify: vi.fn().mockRejectedValue(new Error("shadow boom")) });

      const adapter = new ShadowLlmAdapter({ primary, shadow, logger: testLogger });
      const result = await adapter.classify(EMAIL_INPUT);
      await flushPromises();

      expect(result.category).toBe("work");
      expect(warnSpy).toHaveBeenCalledWith("shadow_llm_error", expect.objectContaining({ method: "classify" }));
    });

    it("logs warn when primary and shadow response shapes differ", async () => {
      const warnSpy = vi.fn();
      const testLogger: Logger = { ...logger, warn: warnSpy };
      // shadow returns an array (totally different shape from object)
      const primary = makeLLM({ classify: vi.fn().mockResolvedValue(CLASSIFICATION_RESULT) });
      const shadow = makeLLM({ classify: vi.fn().mockResolvedValue({ ...CLASSIFICATION_RESULT, deadlines: [{ extra: "field" }] as unknown[] }) });

      const adapter = new ShadowLlmAdapter({ primary, shadow, logger: testLogger });
      await adapter.classify(EMAIL_INPUT);
      await flushPromises();

      // Shapes differ because deadlines[0] has different keys
      expect(warnSpy).toHaveBeenCalledWith("shadow_llm_shape_diff", expect.objectContaining({ method: "classify" }));
    });

    it("does NOT log a shape diff when shapes are identical", async () => {
      const warnSpy = vi.fn();
      const testLogger: Logger = { ...logger, warn: warnSpy };
      const primary = makeLLM({ classify: vi.fn().mockResolvedValue(CLASSIFICATION_RESULT) });
      const shadow = makeLLM({ classify: vi.fn().mockResolvedValue({ ...CLASSIFICATION_RESULT }) });

      const adapter = new ShadowLlmAdapter({ primary, shadow, logger: testLogger });
      await adapter.classify(EMAIL_INPUT);
      await flushPromises();

      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe("synthesize()", () => {
    it("returns the primary synthesis result", async () => {
      const primary = makeLLM({ synthesize: vi.fn().mockResolvedValue("primary summary") });
      const shadow = makeLLM({ synthesize: vi.fn().mockResolvedValue("shadow summary") });

      const adapter = new ShadowLlmAdapter({ primary, shadow, logger });
      const result = await adapter.synthesize("Summarize my day");

      expect(result).toBe("primary summary");
    });

    it("logs warn on shadow error during synthesis", async () => {
      const warnSpy = vi.fn();
      const testLogger: Logger = { ...logger, warn: warnSpy };
      const primary = makeLLM({ synthesize: vi.fn().mockResolvedValue("ok") });
      const shadow = makeLLM({ synthesize: vi.fn().mockRejectedValue(new Error("failed")) });

      const adapter = new ShadowLlmAdapter({ primary, shadow, logger: testLogger });
      await adapter.synthesize("prompt");
      await flushPromises();

      expect(warnSpy).toHaveBeenCalledWith("shadow_llm_error", expect.objectContaining({ method: "synthesize" }));
    });
  });

  describe("extractIntents()", () => {
    it("returns the primary intents result", async () => {
      const intents = [{ tool: "list_deadlines", parameters: {} }];
      const primary = makeLLM({ extractIntents: vi.fn().mockResolvedValue(intents) });
      const shadow = makeLLM({ extractIntents: vi.fn().mockResolvedValue([]) });

      const adapter = new ShadowLlmAdapter({ primary, shadow, logger });
      const result = await adapter.extractIntents("deadlines?", "ctx");

      expect(result).toEqual(intents);
    });

    it("logs warn on shadow error during extractIntents", async () => {
      const warnSpy = vi.fn();
      const testLogger: Logger = { ...logger, warn: warnSpy };
      const primary = makeLLM({ extractIntents: vi.fn().mockResolvedValue([]) });
      const shadow = makeLLM({ extractIntents: vi.fn().mockRejectedValue(new Error("oops")) });

      const adapter = new ShadowLlmAdapter({ primary, shadow, logger: testLogger });
      await adapter.extractIntents("msg", "ctx");
      await flushPromises();

      expect(warnSpy).toHaveBeenCalledWith("shadow_llm_error", expect.objectContaining({ method: "extractIntents" }));
    });
  });
});
