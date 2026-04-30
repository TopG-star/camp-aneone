import type { LLMPort, ClassificationResult, Logger } from "@oneon/domain";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ShadowLlmAdapterConfig {
  primary: LLMPort;
  shadow: LLMPort;
  logger: Logger;
}

// ── Structural-shape diffing ──────────────────────────────────────────────────
// We deliberately log shape (field names + value types), never actual values,
// to avoid leaking email content or PII into logs.

type Shape = string | Record<string, unknown> | unknown[];

function getStructuralShape(value: unknown): Shape {
  if (Array.isArray(value)) {
    return value.length > 0 ? [getStructuralShape(value[0])] : [];
  }
  if (value !== null && typeof value === "object") {
    const shaped: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      shaped[key] = getStructuralShape((value as Record<string, unknown>)[key]);
    }
    return shaped;
  }
  return typeof value;
}

function shapesMatch(a: unknown, b: unknown): boolean {
  return JSON.stringify(getStructuralShape(a)) === JSON.stringify(getStructuralShape(b));
}

// ── Adapter ───────────────────────────────────────────────────────────────────

/**
 * ShadowLlmAdapter wraps a primary LLM and a shadow LLM.
 * The shadow call is fire-and-forget: its result never affects the caller.
 * Structural-shape differences between primary and shadow responses are logged
 * at WARN level. Actual values are never logged (PII safety).
 */
export class ShadowLlmAdapter implements LLMPort {
  private readonly primary: LLMPort;
  private readonly shadow: LLMPort;
  private readonly logger: Logger;

  constructor(config: ShadowLlmAdapterConfig) {
    this.primary = config.primary;
    this.shadow = config.shadow;
    this.logger = config.logger;
  }

  async classify(
    input: Parameters<LLMPort["classify"]>[0]
  ): Promise<ClassificationResult> {
    const primaryResult = await this.primary.classify(input);

    // Fire-and-forget shadow call
    this.shadow
      .classify(input)
      .then((shadowResult) => {
        if (!shapesMatch(primaryResult, shadowResult)) {
          this.logger.warn("shadow_llm_shape_diff", {
            method: "classify",
            primaryShape: getStructuralShape(primaryResult),
            shadowShape: getStructuralShape(shadowResult),
          });
        }
      })
      .catch((err: unknown) => {
        this.logger.warn("shadow_llm_error", {
          method: "classify",
          error: err instanceof Error ? err.message : String(err),
        });
      });

    return primaryResult;
  }

  async synthesize(prompt: string): Promise<string> {
    const primaryResult = await this.primary.synthesize(prompt);

    this.shadow
      .synthesize(prompt)
      .then((shadowResult) => {
        if (!shapesMatch(primaryResult, shadowResult)) {
          this.logger.warn("shadow_llm_shape_diff", {
            method: "synthesize",
            primaryShape: getStructuralShape(primaryResult),
            shadowShape: getStructuralShape(shadowResult),
          });
        }
      })
      .catch((err: unknown) => {
        this.logger.warn("shadow_llm_error", {
          method: "synthesize",
          error: err instanceof Error ? err.message : String(err),
        });
      });

    return primaryResult;
  }

  async extractIntents(
    userMessage: string,
    context: string
  ): Promise<Array<{ tool: string; parameters: Record<string, unknown> }>> {
    const primaryResult = await this.primary.extractIntents(userMessage, context);

    this.shadow
      .extractIntents(userMessage, context)
      .then((shadowResult) => {
        if (!shapesMatch(primaryResult, shadowResult)) {
          this.logger.warn("shadow_llm_shape_diff", {
            method: "extractIntents",
            primaryShape: getStructuralShape(primaryResult),
            shadowShape: getStructuralShape(shadowResult),
          });
        }
      })
      .catch((err: unknown) => {
        this.logger.warn("shadow_llm_error", {
          method: "extractIntents",
          error: err instanceof Error ? err.message : String(err),
        });
      });

    return primaryResult;
  }
}
