import type { Category, Priority } from "../enums.js";

export interface ClassificationResult {
  category: Category;
  priority: Priority;
  summary: string;
  actionItems: string[];
  followUpNeeded: boolean;
  deadlines: Array<{
    dueDate: string;
    description: string;
    confidence: number;
  }>;
}

// ── Focused Ports ────────────────────────────────────────────

export interface IntentExtractionPort {
  extractIntents(
    userMessage: string,
    context: string
  ): Promise<
    Array<{
      tool: string;
      parameters: Record<string, unknown>;
    }>
  >;
}

export interface SynthesisPort {
  synthesize(prompt: string): Promise<string>;
}

// ── Composite Port (backward-compatible) ─────────────────────

export interface LLMPort extends IntentExtractionPort, SynthesisPort {
  classify(input: {
    from: string;
    subject: string;
    bodyPreview: string;
    source: string;
    /** When the email arrived (ISO 8601); relative dates in it are resolved against this. */
    receivedAt: string;
  }): Promise<ClassificationResult>;
}
