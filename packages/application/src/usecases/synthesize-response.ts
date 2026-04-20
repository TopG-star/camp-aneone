import { z } from "zod";
import type { SynthesisPort, ConversationMessage, Logger } from "@oneon/domain";
import type { ToolCallRecord } from "./build-chat-context.js";

// ── Constants ────────────────────────────────────────────────

export const SYNTHESIS_PROMPT_VERSION = "1.0";

// ── Schema ───────────────────────────────────────────────────

export const synthesisResponseSchema = z.object({
  answer: z.string().min(1),
  followUps: z.array(z.string()).optional().default([]),
  usedTools: z.array(z.string()),
  warnings: z.array(z.string()).optional().default([]),
});

export type SynthesisResponse = z.infer<typeof synthesisResponseSchema>;

// ── Types ────────────────────────────────────────────────────

export interface BuildSynthesisPromptInput {
  userMessage: string;
  toolCalls: ToolCallRecord[];
  history: ConversationMessage[];
}

export interface SynthesizeResponseDeps {
  synthesizer: SynthesisPort;
  logger: Logger;
}

export interface SynthesizeResponseResult {
  response: SynthesisResponse;
  meta: {
    durationMs: number;
    promptChars: number;
    rawResponseChars: number;
    promptVersion: string;
  };
}

// ── extractJsonFromText ──────────────────────────────────────

export function extractJsonFromText(raw: string): Record<string, unknown> | null {
  // 1. Try direct parse
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // continue to fallback strategies
  }

  // 2. Try to extract from code fence
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1]) as Record<string, unknown>;
    } catch {
      // continue
    }
  }

  // 3. Try to find first { ... } block
  const braceStart = raw.indexOf("{");
  const braceEnd = raw.lastIndexOf("}");
  if (braceStart !== -1 && braceEnd > braceStart) {
    try {
      return JSON.parse(raw.slice(braceStart, braceEnd + 1)) as Record<string, unknown>;
    } catch {
      // give up
    }
  }

  return null;
}

// ── buildSynthesisPrompt ─────────────────────────────────────

const HISTORY_CAP = 10;
const HISTORY_CHAR_CAP = 500;

function truncateStr(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 3) + "...";
}

export function buildSynthesisPrompt(input: BuildSynthesisPromptInput): string {
  const blocks: string[] = [];

  // ── SYSTEM block ──
  blocks.push(
    [
      `[SYSTEM] promptVersion=${SYNTHESIS_PROMPT_VERSION}`,
      "You are a personal AI assistant synthesizing tool results into a helpful answer.",
      "Return ONLY valid JSON matching this schema — no markdown, no explanation outside the JSON:",
      '{ "answer": string, "followUps"?: string[], "usedTools": string[], "warnings"?: string[] }',
      "",
      "Grounding rules:",
      "- Answer ONLY from the tool results provided below.",
      "- Do not hallucinate or invent facts not present in tool results.",
      "- If tool results are insufficient, say so in the answer and suggest follow-ups.",
      '- Populate "usedTools" with the tools whose results you referenced.',
      '- Use "warnings" for any caveats (stale data, partial results, etc.).',
    ].join("\n")
  );

  // ── CONVERSATION CONTEXT block (lightweight) ──
  const recentHistory = input.history.slice(-HISTORY_CAP);
  if (recentHistory.length > 0) {
    const lines = recentHistory.map(
      (m) => `[${m.role}]: ${truncateStr(m.content, HISTORY_CHAR_CAP)}`
    );
    blocks.push(["[CONVERSATION CONTEXT]", ...lines].join("\n"));
  }

  // ── TOOL RESULTS block ──
  const successCalls = input.toolCalls.filter((tc) => tc.result !== null);
  const failedCalls = input.toolCalls.filter((tc) => tc.error !== null);

  const toolLines: string[] = [];
  for (const tc of successCalls) {
    toolLines.push(`[${tc.tool}]: ${tc.result!.summary}`);
  }

  if (failedCalls.length > 0) {
    toolLines.push("");
    toolLines.push(
      "Note: The following tools failed and have no results — mention in warnings if relevant:"
    );
    for (const tc of failedCalls) {
      toolLines.push(`- ${tc.tool} failed: ${tc.error}`);
    }
  }

  blocks.push(
    ["[TOOL RESULTS]", ...(toolLines.length > 0 ? toolLines : ["(no tool results)"])].join("\n")
  );

  // ── USER QUESTION block ──
  blocks.push(`[USER QUESTION]\n${input.userMessage}`);

  return blocks.join("\n\n");
}

// ── synthesizeResponse ───────────────────────────────────────

export async function synthesizeResponse(
  deps: SynthesizeResponseDeps,
  input: BuildSynthesisPromptInput
): Promise<SynthesizeResponseResult> {
  const prompt = buildSynthesisPrompt(input);
  const start = Date.now();

  const raw = await deps.synthesizer.synthesize(prompt);

  const durationMs = Date.now() - start;
  const meta = {
    durationMs,
    promptChars: prompt.length,
    rawResponseChars: raw.length,
    promptVersion: SYNTHESIS_PROMPT_VERSION,
  };

  // Try to parse as structured JSON
  const parsed = extractJsonFromText(raw);
  if (parsed !== null) {
    const zodResult = synthesisResponseSchema.safeParse(parsed);
    if (zodResult.success) {
      return { response: zodResult.data, meta };
    }
  }

  // Fallback: raw text becomes the answer
  deps.logger.warn("Synthesis response was not structured JSON, using raw text fallback", {
    rawLength: raw.length,
  });

  const usedToolNames = input.toolCalls
    .filter((tc) => tc.result !== null)
    .map((tc) => tc.tool);

  return {
    response: {
      answer: raw,
      followUps: [],
      usedTools: usedToolNames,
      warnings: ["Response was not structured JSON"],
    },
    meta,
  };
}
