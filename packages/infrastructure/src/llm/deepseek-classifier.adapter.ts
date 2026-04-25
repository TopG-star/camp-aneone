import type { LLMPort, ClassificationResult, Logger } from "@oneon/domain";
import { classificationSchema, intentSchema } from "./classification.schema.js";
import { CircuitBreaker, type CircuitBreakerOptions } from "./circuit-breaker.js";
import {
  DeepSeekHttpClient,
  DeepSeekRateLimitError,
  DeepSeekEmptyResponseError,
  type DeepSeekRequest,
} from "./deepseek-http-client.js";

// ── Config ────────────────────────────────────────────────────────────────────

export interface DeepSeekClassifierConfig {
  apiKey: string;
  /** Model used for classify() and extractIntents() — fast, cheap, structured output. */
  classifierModel: string;
  /** Model used for synthesize() — higher quality, longer context. */
  synthesisModel: string;
  maxRetries: number;
  /** Timeout in ms for classifier calls (classify, extractIntents). */
  classifierTimeoutMs: number;
  /** Timeout in ms for synthesis calls (synthesize). */
  synthesisTimeoutMs: number;
  circuitBreaker: Omit<CircuitBreakerOptions, "logger">;
  logger: Logger;
  /** Override base URL — useful for tests / proxies. */
  baseUrl?: string;
}

// ── Shared prompts ────────────────────────────────────────────────────────────
// Both prompts already contain the word "json" which DeepSeek requires when
// response_format=json_object is enabled.

const CLASSIFICATION_SYSTEM_PROMPT = `You are an email classification assistant. Analyze the email and return a JSON object with exactly these fields:
- category: one of "urgent", "work", "personal", "newsletter", "transactional", "spam"
- priority: integer 1-5 (1 = most urgent, 5 = least)
- summary: brief 1-2 sentence summary (max 500 chars)
- actionItems: array of action item strings (empty array if none)
- followUpNeeded: boolean indicating if a follow-up is needed
- deadlines: array of {dueDate: ISO date string, description: string, confidence: number 0-1}

Return ONLY valid JSON. No markdown, no explanation, no wrapping.`;

const INTENT_SYSTEM_PROMPT = `You are a personal assistant intent extractor. Given a user message and context, extract structured intents.
Return a JSON array of objects, each with:
- tool: string naming the tool to invoke (e.g. "list_deadlines", "search_emails", "list_calendar_events")
- parameters: object with relevant key-value pairs for the tool

Return ONLY a valid JSON array. No markdown, no explanation, no wrapping.`;

// ── Adapter ───────────────────────────────────────────────────────────────────

export class DeepSeekClassifierAdapter implements LLMPort {
  private readonly client: DeepSeekHttpClient;
  private readonly classifierModel: string;
  private readonly synthesisModel: string;
  private readonly maxRetries: number;
  private readonly classifierTimeoutMs: number;
  private readonly synthesisTimeoutMs: number;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly logger: Logger;

  constructor(config: DeepSeekClassifierConfig) {
    this.client = new DeepSeekHttpClient(config.apiKey, config.baseUrl);
    this.classifierModel = config.classifierModel;
    this.synthesisModel = config.synthesisModel;
    this.maxRetries = config.maxRetries;
    this.classifierTimeoutMs = config.classifierTimeoutMs;
    this.synthesisTimeoutMs = config.synthesisTimeoutMs;
    this.logger = config.logger;
    this.circuitBreaker = new CircuitBreaker({
      ...config.circuitBreaker,
      logger: config.logger,
    });
  }

  // ── Public interface ────────────────────────────────────────────────────────

  async classify(input: {
    from: string;
    subject: string;
    bodyPreview: string;
    source: string;
  }): Promise<ClassificationResult> {
    const userPrompt = [
      `From: ${input.from}`,
      `Subject: ${input.subject}`,
      `Source: ${input.source}`,
      `Body: ${input.bodyPreview}`,
    ].join("\n");

    return this.circuitBreaker.execute(async () => {
      let lastError: unknown;

      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        try {
          const raw = await this.callDeepSeek(
            this.classifierModel,
            CLASSIFICATION_SYSTEM_PROMPT,
            userPrompt,
            this.classifierTimeoutMs,
            true, // JSON output enforcement
          );

          const parsed = classificationSchema.safeParse(JSON.parse(raw));
          if (parsed.success) {
            this.logger.debug("Classification successful", {
              model: this.classifierModel,
              attempt,
              category: parsed.data.category,
              priority: parsed.data.priority,
            });
            return parsed.data as ClassificationResult;
          }

          lastError = new Error(
            `Zod validation failed: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ")}`,
          );
          this.logger.warn("Classification output validation failed, retrying", {
            attempt,
            errors: parsed.error.issues,
          });
        } catch (error) {
          // 429 — do not retry; surface immediately (caller / circuit breaker handles it)
          if (error instanceof DeepSeekRateLimitError) throw error;

          lastError = error;

          if (error instanceof DeepSeekEmptyResponseError || error instanceof SyntaxError) {
            this.logger.warn("Retrying classification after recoverable error", {
              attempt,
              error: (error as Error).message,
            });
            continue;
          }

          throw error;
        }
      }

      throw lastError;
    });
  }

  async synthesize(prompt: string): Promise<string> {
    return this.circuitBreaker.execute(async () => {
      const result = await this.callDeepSeek(
        this.synthesisModel,
        "You are a helpful personal assistant. Provide clear, concise responses.",
        prompt,
        this.synthesisTimeoutMs,
        false, // free-form text, no JSON enforcement
      );
      this.logger.debug("Synthesis successful", {
        model: this.synthesisModel,
        responseLength: result.length,
      });
      return result;
    });
  }

  async extractIntents(
    userMessage: string,
    context: string,
  ): Promise<Array<{ tool: string; parameters: Record<string, unknown> }>> {
    const userPrompt = `Context:\n${context}\n\nUser message: ${userMessage}`;

    return this.circuitBreaker.execute(async () => {
      let lastError: unknown;

      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        try {
          const raw = await this.callDeepSeek(
            this.classifierModel,
            INTENT_SYSTEM_PROMPT,
            userPrompt,
            this.classifierTimeoutMs,
            true, // JSON output enforcement
          );

          const parsed = intentSchema.safeParse(JSON.parse(raw));
          if (parsed.success) {
            this.logger.debug("Intent extraction successful", {
              model: this.classifierModel,
              attempt,
              intentCount: parsed.data.length,
            });
            return parsed.data;
          }

          lastError = new Error(
            `Zod validation failed: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ")}`,
          );
          this.logger.warn("Intent extraction validation failed, retrying", {
            attempt,
            errors: parsed.error.issues,
          });
        } catch (error) {
          if (error instanceof DeepSeekRateLimitError) throw error;

          lastError = error;

          if (error instanceof DeepSeekEmptyResponseError || error instanceof SyntaxError) {
            this.logger.warn("Retrying intent extraction after recoverable error", {
              attempt,
              error: (error as Error).message,
            });
            continue;
          }

          throw error;
        }
      }

      throw lastError;
    });
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private async callDeepSeek(
    model: string,
    systemPrompt: string,
    userPrompt: string,
    timeoutMs: number,
    jsonMode: boolean,
  ): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const body: DeepSeekRequest = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      // 1024 tokens is safe for structured outputs; synthesis inherits default.
      // Keep above empty-content mitigation floor (per DeepSeek guidance).
      max_tokens: 1024,
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
    };

    try {
      return await this.client.chatCompletion(body, controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }
}
