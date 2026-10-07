import { describe, it, expect, vi } from "vitest";
import { ApprovedModelCall, ProviderError } from "@oneon/application";
import { DeepSeekProvider } from "./deepseek-provider.js";
import { DeepSeekApiError, DeepSeekEmptyResponseError, DeepSeekRateLimitError } from "../deepseek-http-client.js";

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const call = (json: boolean) =>
  ApprovedModelCall.mint({ callId: "c1", provider: "deepseek", model: "deepseek-v4-flash", system: "SYS", user: "USER", json, maxTokens: 1024, timeoutMs: 5000 });
const make = (chatCompletion: ReturnType<typeof vi.fn>) =>
  new DeepSeekProvider({ apiKey: "k", circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 1000 }, logger, client: { chatCompletion } });

describe("DeepSeekProvider", () => {
  it("sends exactly the approved system and user text, with JSON mode when asked", async () => {
    const chatCompletion = vi.fn().mockResolvedValue('{"ok":true}');
    await expect(make(chatCompletion).complete(call(true))).resolves.toEqual({ text: '{"ok":true}' });
    expect(chatCompletion.mock.calls[0][0]).toEqual({
      model: "deepseek-v4-flash",
      messages: [
        { role: "system", content: "SYS" },
        { role: "user", content: "USER" },
      ],
      max_tokens: 1024,
      response_format: { type: "json_object" },
    });
  });
  it("omits JSON mode for text output", async () => {
    const chatCompletion = vi.fn().mockResolvedValue("hello");
    await make(chatCompletion).complete(call(false));
    expect(chatCompletion.mock.calls[0][0]).not.toHaveProperty("response_format");
  });
  it.each([
    [new DeepSeekRateLimitError(), false],
    [new DeepSeekEmptyResponseError(), true],
    [new DeepSeekApiError("server error", 503), true],
    [new DeepSeekApiError("bad request", 400), false],
    [Object.assign(new Error("aborted"), { name: "AbortError" }), true],
  ])("maps %s to retryable=%s", async (error, retryable) => {
    const chatCompletion = vi.fn().mockRejectedValue(error);
    const failure = await make(chatCompletion).complete(call(true)).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).retryable).toBe(retryable);
  });
  it("replaces unknown error text with a fixed message", async () => {
    const chatCompletion = vi.fn().mockRejectedValue(new SyntaxError("Unexpected token in {\"secret\":\"abc\"}"));
    const failure = await make(chatCompletion).complete(call(true)).catch((e: unknown) => e);
    expect(failure).toMatchObject({ message: "DeepSeek request failed", retryable: false });
  });
});
