import type { Logger } from "@oneon/domain";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Patterns that match sensitive values in log output.
 * Applied at the logger boundary — every JSON log entry is scrubbed automatically.
 */
const REDACTION_PATTERNS: [RegExp, string][] = [
  // Authorization: Bearer <token>
  [/("?Authorization"?\s*[:=]\s*"?Bearer\s+)[^\s",}]+/gi, "$1[REDACTED]"],
  // Common secret env var values when accidentally spread into meta
  [/("?(?:api[_-]?token|api[_-]?key|secret|password|access[_-]?token|refresh[_-]?token|private[_-]?key|encryption[_-]?key)"?\s*[:=]\s*"?)([^",}\s]{8,})/gi, "$1[REDACTED]"],
  // GitHub PATs (ghp_, gho_, ghs_, github_pat_)
  [/\b(ghp_|gho_|ghs_|github_pat_)[A-Za-z0-9_]{16,}/g, "[REDACTED_GITHUB_TOKEN]"],
  // Anthropic keys (sk-ant-)
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, "[REDACTED_ANTHROPIC_KEY]"],
  // Generic long base64 blobs that look like tokens (40+ chars)
  [/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, "[REDACTED_BASE64]"],
];

/**
 * Scrub sensitive patterns from a serialized log string.
 * Operates on the final JSON string so it catches values regardless of
 * where they appear (message, meta keys, nested objects).
 */
export function redactSecrets(input: string): string {
  let result = input;
  for (const [pattern, replacement] of REDACTION_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

export class StructuredLogger implements Logger {
  private readonly context: string;
  private readonly minLevel: number;

  constructor(context: string, logLevel: LogLevel = "info") {
    this.context = context;
    this.minLevel = LEVEL_RANK[logLevel];
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.log("info", message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.log("warn", message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.log("error", message, meta);
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.log("debug", message, meta);
  }

  private log(
    level: LogLevel,
    message: string,
    meta?: Record<string, unknown>
  ): void {
    if (LEVEL_RANK[level] < this.minLevel) return;

    const entry = {
      timestamp: new Date().toISOString(),
      level,
      context: this.context,
      message,
      ...meta,
    };
    const output = redactSecrets(JSON.stringify(entry));

    if (level === "error") {
      process.stderr.write(output + "\n");
    } else {
      process.stdout.write(output + "\n");
    }
  }
}
