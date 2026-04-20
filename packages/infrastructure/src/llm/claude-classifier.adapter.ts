import Anthropic from "@anthropic-ai/sdk";
import type { LLMPort, ClassificationResult, Logger } from "@oneon/domain";
import { classificationSchema, intentSchema } from "./classification.schema.js";
import { CircuitBreaker, type CircuitBreakerOptions } from "./circuit-breaker.js";

export interface ClaudeClassifierConfig {
  apiKey: string;
  classifierModel: string;
  synthesisModel: string;
  maxRetries: number;
  timeoutMs: number;
  circuitBreaker: Omit<CircuitBreakerOptions, "logger">;
  logger: Logger;
}

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

export class ClaudeClassifierAdapter implements LLMPort {
  private readonly client: Anthropic;
  private readonly classifierModel: string;
  private readonly synthesisModel: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly logger: Logger;

  constructor(config: ClaudeClassifierConfig) {
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.classifierModel = config.classifierModel;
    this.synthesisModel = config.synthesisModel;
    this.maxRetries = config.maxRetries;
    this.timeoutMs = config.timeoutMs;
    this.logger = config.logger;
    this.circuitBreaker = new CircuitBreaker({
      ...config.circuitBreaker,
      logger: config.logger,
    });
  }

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
          const raw = await this.callClaude(
            this.classifierModel,
            CLASSIFICATION_SYSTEM_PROMPT,
            userPrompt
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
            `Zod validation failed: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ")}`
          );
          this.logger.warn("Classification output validation failed, retrying", {
            attempt,
            errors: parsed.error.issues,
          });
        } catch (error) {
          lastError = error;

          if (error instanceof SyntaxError) {
            this.logger.warn("Failed to parse LLM JSON response, retrying", {
              attempt,
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
      const result = await this.callClaude(
        this.synthesisModel,
        "You are a helpful personal assistant. Provide clear, concise responses.",
        prompt
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
    context: string
  ): Promise<Array<{ tool: string; parameters: Record<string, unknown> }>> {
    const userPrompt = `Context:\n${context}\n\nUser message: ${userMessage}`;

    return this.circuitBreaker.execute(async () => {
      let lastError: unknown;

      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        try {
          const raw = await this.callClaude(
            this.classifierModel,
            INTENT_SYSTEM_PROMPT,
            userPrompt
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
            `Zod validation failed: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ")}`
          );
          this.logger.warn("Intent extraction validation failed, retrying", {
            attempt,
            errors: parsed.error.issues,
          });
        } catch (error) {
          lastError = error;

          if (error instanceof SyntaxError) {
            this.logger.warn("Failed to parse intent JSON response, retrying", {
              attempt,
            });
            continue;
          }

          throw error;
        }
      }

      throw lastError;
    });
  }

  private async callClaude(
    model: string,
    systemPrompt: string,
    userPrompt: string
  ): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.client.messages.create(
        {
          model,
          max_tokens: 1024,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
        },
        { signal: controller.signal }
      );

      const textBlock = response.content.find((block) => block.type === "text");
      if (!textBlock || textBlock.type !== "text") {
        throw new Error("No text content in Claude response");
      }

      return textBlock.text;
    } finally {
      clearTimeout(timeout);
    }
  }
}
