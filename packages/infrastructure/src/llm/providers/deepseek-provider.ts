import type { Logger } from "@oneon/domain";
import { ProviderError, type ApprovedModelCall, type ModelProvider, type ProviderCompletion } from "@oneon/application";
import { CircuitBreaker } from "../circuit-breaker.js";
import { DeepSeekApiError, DeepSeekEmptyResponseError, DeepSeekHttpClient, DeepSeekRateLimitError, type DeepSeekRequest } from "../deepseek-http-client.js";

export interface DeepSeekProviderConfig {
  apiKey: string;
  baseUrl?: string;
  circuitBreaker: { failureThreshold: number; resetTimeoutMs: number };
  logger: Logger;
  client?: Pick<DeepSeekHttpClient, "chatCompletion">;
}

export class DeepSeekProvider implements ModelProvider {
  readonly id = "deepseek" as const;
  private readonly client: Pick<DeepSeekHttpClient, "chatCompletion">;
  private readonly breaker: CircuitBreaker;

  constructor(config: DeepSeekProviderConfig) {
    this.client = config.client ?? new DeepSeekHttpClient(config.apiKey, config.baseUrl);
    this.breaker = new CircuitBreaker({ ...config.circuitBreaker, logger: config.logger });
  }

  async complete(call: ApprovedModelCall): Promise<ProviderCompletion> {
    const body: DeepSeekRequest = {
      model: call.model,
      messages: [
        { role: "system", content: call.system },
        { role: "user", content: call.user },
      ],
      max_tokens: call.maxTokens,
      ...(call.json ? { response_format: { type: "json_object" } } : {}),
    };
    try {
      const text = await this.breaker.execute(async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), call.timeoutMs);
        try {
          return await this.client.chatCompletion(body, controller.signal);
        } finally {
          clearTimeout(timer);
        }
      });
      return { text };
    } catch (error) {
      throw toProviderError(error);
    }
  }
}

function toProviderError(error: unknown): ProviderError {
  if (error instanceof DeepSeekRateLimitError) return new ProviderError("DeepSeek rate limit", false);
  if (error instanceof DeepSeekEmptyResponseError) return new ProviderError("DeepSeek returned an empty response", true);
  if (error instanceof DeepSeekApiError) return new ProviderError(`DeepSeek API error ${error.status}`, error.status >= 500);
  if (error instanceof Error && error.name === "AbortError") return new ProviderError("DeepSeek request timed out", true);
  return new ProviderError("DeepSeek request failed", false);
}
