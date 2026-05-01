import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Logger } from "@oneon/domain";
import { DeepSeekClassifierAdapter, type DeepSeekClassifierConfig } from "./deepseek-classifier.adapter.js";
import {
  DeepSeekHttpClient,
  DeepSeekRateLimitError,
  DeepSeekEmptyResponseError,
} from "./deepseek-http-client.js";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("./deepseek-http-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./deepseek-http-client.js")>();
  return {
    ...actual,
    DeepSeekHttpClient: vi.fn().mockImplementation(() => ({
      chatCompletion: vi.fn(),
    })),
  };
});

const logger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

// ── Fixtures ──────────────────────────────────────────────────────────────────

const VALID_CLASSIFICATION = {
  category: "work",
  priority: 2,
  summary: "Project deadline reminder from manager.",
  actionItems: ["Review PR before 5pm"],
  followUpNeeded: true,
  deadlines: [{ dueDate: "2026-04-30T00:00:00Z", description: "PR review", confidence: 0.9 }],
};

const EMAIL_INPUT = {
  from: "boss@company.com",
  subject: "Deadline tomorrow",
  bodyPreview: "Please review the PR before EOD.",
  source: "gmail",
};

const defaultConfig: DeepSeekClassifierConfig = {
  apiKey: "sk-test",
  classifierModel: "deepseek-test-classifier",
  synthesisModel: "deepseek-test-synthesis",
  maxRetries: 2,
  classifierTimeoutMs: 5000,
  synthesisTimeoutMs: 10000,
  circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 60000 },
  logger,
  baseUrl: "https://test.deepseek.api",
};

function getChatCompletion(): ReturnType<typeof vi.fn> {
  const ClientMock = vi.mocked(DeepSeekHttpClient);
  const instance = ClientMock.mock.results[ClientMock.mock.results.length - 1]?.value;
  return instance.chatCompletion as ReturnType<typeof vi.fn>;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("DeepSeekClassifierAdapter", () => {
  let adapter: DeepSeekClassifierAdapter;
  let chatCompletion: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new DeepSeekClassifierAdapter(defaultConfig);
    chatCompletion = getChatCompletion();
  });

  // ── classify() ─────────────────────────────────────────────────────────────

  describe("classify()", () => {
    it("returns a valid ClassificationResult on success", async () => {
      chatCompletion.mockResolvedValueOnce(JSON.stringify(VALID_CLASSIFICATION));

      const result = await adapter.classify(EMAIL_INPUT);

      expect(result.category).toBe("work");
      expect(result.priority).toBe(2);
      expect(result.followUpNeeded).toBe(true);
    });

    it("sends response_format=json_object for structured output", async () => {
      chatCompletion.mockResolvedValueOnce(JSON.stringify(VALID_CLASSIFICATION));

      await adapter.classify(EMAIL_INPUT);

      const body = chatCompletion.mock.calls[0][0];
      expect(body.response_format).toEqual({ type: "json_object" });
    });

    it("uses classifierModel for classify calls", async () => {
      chatCompletion.mockResolvedValueOnce(JSON.stringify(VALID_CLASSIFICATION));

      await adapter.classify(EMAIL_INPUT);

      const body = chatCompletion.mock.calls[0][0];
      expect(body.model).toBe("deepseek-test-classifier");
    });

    it("retries on SyntaxError (bad JSON) and succeeds on second attempt", async () => {
      chatCompletion
        .mockResolvedValueOnce("not json at all")
        .mockResolvedValueOnce(JSON.stringify(VALID_CLASSIFICATION));

      const result = await adapter.classify(EMAIL_INPUT);

      expect(result.category).toBe("work");
      expect(chatCompletion).toHaveBeenCalledTimes(2);
    });

    it("retries on DeepSeekEmptyResponseError and succeeds on second attempt", async () => {
      chatCompletion
        .mockRejectedValueOnce(new DeepSeekEmptyResponseError())
        .mockResolvedValueOnce(JSON.stringify(VALID_CLASSIFICATION));

      const result = await adapter.classify(EMAIL_INPUT);

      expect(result.category).toBe("work");
      expect(chatCompletion).toHaveBeenCalledTimes(2);
    });

    it("retries on Zod validation failure and succeeds on second attempt", async () => {
      const invalid = { ...VALID_CLASSIFICATION, category: "unknown_category" };
      chatCompletion
        .mockResolvedValueOnce(JSON.stringify(invalid))
        .mockResolvedValueOnce(JSON.stringify(VALID_CLASSIFICATION));

      const result = await adapter.classify(EMAIL_INPUT);

      expect(result.category).toBe("work");
      expect(chatCompletion).toHaveBeenCalledTimes(2);
    });

    it("does NOT retry on DeepSeekRateLimitError — throws immediately", async () => {
      chatCompletion.mockRejectedValueOnce(new DeepSeekRateLimitError());

      await expect(adapter.classify(EMAIL_INPUT)).rejects.toThrow(DeepSeekRateLimitError);
      expect(chatCompletion).toHaveBeenCalledTimes(1);
    });

    it("throws after exhausting all retries", async () => {
      chatCompletion.mockResolvedValue("not json");

      await expect(adapter.classify(EMAIL_INPUT)).rejects.toThrow(SyntaxError);
      // 1 initial + maxRetries=2 more = 3 total
      expect(chatCompletion).toHaveBeenCalledTimes(3);
    });
  });

  // ── synthesize() ───────────────────────────────────────────────────────────

  describe("synthesize()", () => {
    it("returns the synthesis response text", async () => {
      chatCompletion.mockResolvedValueOnce("Here is your summary.");

      const result = await adapter.synthesize("Summarize my day");

      expect(result).toBe("Here is your summary.");
    });

    it("uses synthesisModel for synthesis calls", async () => {
      chatCompletion.mockResolvedValueOnce("response");

      await adapter.synthesize("prompt");

      const body = chatCompletion.mock.calls[0][0];
      expect(body.model).toBe("deepseek-test-synthesis");
    });

    it("does NOT set response_format for synthesis calls", async () => {
      chatCompletion.mockResolvedValueOnce("text response");

      await adapter.synthesize("prompt");

      const body = chatCompletion.mock.calls[0][0];
      expect(body.response_format).toBeUndefined();
    });

    it("does NOT retry on DeepSeekRateLimitError during synthesis", async () => {
      chatCompletion.mockRejectedValueOnce(new DeepSeekRateLimitError());

      await expect(adapter.synthesize("prompt")).rejects.toThrow(DeepSeekRateLimitError);
      expect(chatCompletion).toHaveBeenCalledTimes(1);
    });
  });

  // ── extractIntents() ───────────────────────────────────────────────────────

  describe("extractIntents()", () => {
    it("returns parsed intents on success", async () => {
      const intents = [{ tool: "list_deadlines", parameters: {} }];
      chatCompletion.mockResolvedValueOnce(JSON.stringify(intents));

      const result = await adapter.extractIntents("what deadlines do I have?", "context");

      expect(result).toHaveLength(1);
      expect(result[0].tool).toBe("list_deadlines");
    });

    it("sends response_format=json_object for intent extraction", async () => {
      chatCompletion.mockResolvedValueOnce(JSON.stringify([]));

      await adapter.extractIntents("msg", "ctx");

      const body = chatCompletion.mock.calls[0][0];
      expect(body.response_format).toEqual({ type: "json_object" });
    });

    it("uses classifierModel for intent extraction", async () => {
      chatCompletion.mockResolvedValueOnce(JSON.stringify([]));

      await adapter.extractIntents("msg", "ctx");

      const body = chatCompletion.mock.calls[0][0];
      expect(body.model).toBe("deepseek-test-classifier");
    });

    it("does NOT retry on DeepSeekRateLimitError during intent extraction", async () => {
      chatCompletion.mockRejectedValueOnce(new DeepSeekRateLimitError());

      await expect(adapter.extractIntents("msg", "ctx")).rejects.toThrow(DeepSeekRateLimitError);
      expect(chatCompletion).toHaveBeenCalledTimes(1);
    });
  });

  // ── Timeout wiring ──────────────────────────────────────────────────────────

  describe("timeout wiring", () => {
    it("passes an AbortSignal to classify calls", async () => {
      chatCompletion.mockResolvedValueOnce(JSON.stringify(VALID_CLASSIFICATION));

      await adapter.classify(EMAIL_INPUT);

      const [, signal] = chatCompletion.mock.calls[0] as [unknown, AbortSignal | undefined];
      expect(signal).toBeDefined();
      expect(signal).toBeInstanceOf(AbortSignal);
    });

    it("passes an AbortSignal to synthesize calls", async () => {
      chatCompletion.mockResolvedValueOnce("text");

      await adapter.synthesize("prompt");

      const [, signal] = chatCompletion.mock.calls[0] as [unknown, AbortSignal | undefined];
      expect(signal).toBeDefined();
      expect(signal).toBeInstanceOf(AbortSignal);
    });
  });
});
