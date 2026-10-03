import Anthropic from "@anthropic-ai/sdk";
import type { Logger } from "@oneon/domain";
import { ProviderError, type ApprovedModelCall, type ModelProvider, type ProviderCompletion } from "@oneon/application";
import { CircuitBreaker } from "../circuit-breaker.js";

type MessagesClient = {
  messages: {
    create(
      body: unknown,
      options: { signal: AbortSignal },
    ): Promise<{ content: Array<{ type: string; text?: string }>; usage?: { input_tokens: number; output_tokens: number } }>;
  };
};

export interface AnthropicProviderConfig {
  apiKey: string;
  circuitBreaker: { failureThreshold: number; resetTimeoutMs: number };
  logger: Logger;
  client?: MessagesClient;
}

export class AnthropicProvider implements ModelProvider {
  readonly id = "anthropic" as const;
  private readonly client: MessagesClient;
  private readonly breaker: CircuitBreaker;

  constructor(config: AnthropicProviderConfig) {
    this.client = config.client ?? (new Anthropic({ apiKey: config.apiKey }) as unknown as MessagesClient);
    this.breaker = new CircuitBreaker({ ...config.circuitBreaker, logger: config.logger });
  }

  async complete(call: ApprovedModelCall): Promise<ProviderCompletion> {
    try {
      return await this.breaker.execute(async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), call.timeoutMs);
        try {
          const response = await this.client.messages.create(
            { model: call.model, max_tokens: call.maxTokens, system: call.system, messages: [{ role: "user", content: call.user }] },
            { signal: controller.signal },
          );
          const block = response.content.find((b) => b.type === "text");
          if (!block?.text) throw new ProviderError("Anthropic returned no text", true);
          return { text: block.text, inputTokens: response.usage?.input_tokens, outputTokens: response.usage?.output_tokens };
        } finally {
          clearTimeout(timer);
        }
      });
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      const status = (error as { status?: number }).status;
      if (typeof status === "number") throw new ProviderError(`Anthropic API error ${status}`, status >= 500);
      if (error instanceof Error && error.name === "AbortError") throw new ProviderError("Anthropic request timed out", true);
      throw new ProviderError(error instanceof Error ? error.message : String(error), false);
    }
  }
}
