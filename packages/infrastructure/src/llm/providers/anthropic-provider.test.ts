import { describe, it, expect, vi } from "vitest";
import { ApprovedModelCall, ProviderError } from "@oneon/application";
import { AnthropicProvider } from "./anthropic-provider.js";

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const call = ApprovedModelCall.mint({ callId: "c1", provider: "anthropic", model: "claude-x", system: "SYS", user: "USER", json: true, maxTokens: 512, timeoutMs: 5000 });
const make = (create: ReturnType<typeof vi.fn>) =>
  new AnthropicProvider({ apiKey: "k", circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 1000 }, logger, client: { messages: { create } } });

describe("AnthropicProvider", () => {
  it("sends the approved text and returns the text block with token usage", async () => {
    const create = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "hi" }], usage: { input_tokens: 10, output_tokens: 2 } });
    await expect(make(create).complete(call)).resolves.toEqual({ text: "hi", inputTokens: 10, outputTokens: 2 });
    expect(create.mock.calls[0][0]).toEqual({ model: "claude-x", max_tokens: 512, system: "SYS", messages: [{ role: "user", content: "USER" }] });
  });
  it("treats a response without text as a retryable failure", async () => {
    const failure = await make(vi.fn().mockResolvedValue({ content: [] })).complete(call).catch((e: unknown) => e);
    expect(failure).toMatchObject({ retryable: true });
    expect(failure).toBeInstanceOf(ProviderError);
  });
  it.each([
    [{ status: 429 }, false],
    [{ status: 401 }, false],
    [{ status: 529 }, true],
  ])("maps HTTP %o to retryable=%s", async (shape, retryable) => {
    const failure = await make(vi.fn().mockRejectedValue(Object.assign(new Error("x"), shape))).complete(call).catch((e: unknown) => e);
    expect((failure as ProviderError).retryable).toBe(retryable);
  });
});
