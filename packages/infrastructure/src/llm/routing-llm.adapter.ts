import type { LLMPort, ClassificationResult } from "@oneon/domain";

// ── Adapter ───────────────────────────────────────────────────────────────────

export interface RoutingLlmAdapterConfig {
  /**
   * Handles `classify()` and `extractIntents()` — typically the fast/cheap
   * model selected by `LLM_PROVIDER`.
   */
  standard: LLMPort;
  /**
   * Handles `synthesize()` — typically the higher-quality reasoning model
   * selected by `LLM_REASONING_PROVIDER_PREMIUM`.
   */
  reasoning: LLMPort;
}

/**
 * RoutingLlmAdapter dispatches each LLMPort method to the appropriate provider:
 *   classify()        → standard (fast structured output)
 *   extractIntents()  → standard (fast structured output)
 *   synthesize()      → reasoning (premium quality / longer context)
 *
 * When `standard === reasoning` (same instance), it behaves identically to
 * calling that single adapter directly.
 */
export class RoutingLlmAdapter implements LLMPort {
  private readonly standard: LLMPort;
  private readonly reasoning: LLMPort;

  constructor(config: RoutingLlmAdapterConfig) {
    this.standard = config.standard;
    this.reasoning = config.reasoning;
  }

  classify(input: Parameters<LLMPort["classify"]>[0]): Promise<ClassificationResult> {
    return this.standard.classify(input);
  }

  synthesize(prompt: string): Promise<string> {
    return this.reasoning.synthesize(prompt);
  }

  extractIntents(
    userMessage: string,
    context: string
  ): Promise<Array<{ tool: string; parameters: Record<string, unknown> }>> {
    return this.standard.extractIntents(userMessage, context);
  }
}
