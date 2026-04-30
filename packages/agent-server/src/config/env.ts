import { z } from "zod";

const envSchema = z.object({
  // ── Core ──────────────────────────────────────────────────
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  PORT: z.coerce.number().default(4000),
  PUBLIC_URL: z.string().default("http://localhost:3000"),

  // ── Auth ──────────────────────────────────────────────────
  NEXTAUTH_SECRET: z.string().min(1),
  ALLOWED_EMAILS: z
    .string()
    .min(1)
    .transform((v) => v.split(",").map((e) => e.trim().toLowerCase())),
  API_TOKEN: z.string().min(1),

  // ── OAuth Token Encryption ────────────────────────────────
  OAUTH_TOKEN_ENCRYPTION_KEY: z.string().min(32).optional(),

  // ── Google OAuth ──────────────────────────────────────────
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  // ── LLM Provider Selection ────────────────────────────────
  /** Which provider to use as the primary LLM. */
  LLM_PROVIDER: z.enum(["anthropic", "deepseek"]).default("anthropic"),
  /** Optional shadow provider for A/B comparison (fire-and-forget). */
  LLM_SHADOW_PROVIDER: z.enum(["anthropic", "deepseek", "none"]).default("none"),
  /** Optional premium provider used only for synthesize() calls. */
  LLM_REASONING_PROVIDER_PREMIUM: z.enum(["anthropic", "deepseek", "none"]).default("none"),

  // ── Anthropic ─────────────────────────────────────────────
  ANTHROPIC_API_KEY: z.string().optional(),
  /** Model used for classify() and extractIntents() when provider=anthropic. */
  LLM_CLASSIFIER_MODEL: z.string().default("claude-3-5-haiku-20241022"),
  /** Model used for synthesize() when provider=anthropic. */
  LLM_SYNTHESIS_MODEL: z.string().default("claude-sonnet-4-20250514"),

  // ── DeepSeek ──────────────────────────────────────────────
  DEEPSEEK_API_KEY: z.string().optional(),
  /** Model for classify() / extractIntents() when provider=deepseek. No default — must be set explicitly. */
  DEEPSEEK_CLASSIFIER_MODEL: z.string().optional(),
  /** Model for synthesize() when provider=deepseek (or premium). No default — must be set explicitly. */
  DEEPSEEK_SYNTHESIS_MODEL: z.string().optional(),

  // ── LLM Shared ────────────────────────────────────────────
  LLM_MAX_RETRIES: z.coerce.number().default(3),
  /** Timeout for classifier calls (classify, extractIntents). ms. */
  LLM_CLASSIFIER_TIMEOUT_MS: z.coerce.number().default(15000),
  /** Timeout for synthesis calls (synthesize). ms. */
  LLM_SYNTHESIS_TIMEOUT_MS: z.coerce.number().default(30000),
  /** Legacy combined timeout — kept for backward compat; used only by the Claude adapter. */
  LLM_TIMEOUT_MS: z.coerce.number().default(30000),

  // ── Database ──────────────────────────────────────────────
  DATABASE_PATH: z.string().default("./data/oneon.db"),

  // ── Gmail ─────────────────────────────────────────────────
  GMAIL_POLL_INTERVAL_MS: z.coerce.number().default(180000),
  GMAIL_MAX_RESULTS: z.coerce.number().default(20),
  GOOGLE_REFRESH_TOKEN: z.string().optional(),
  GMAIL_SKIP_PROMOTIONS: z
    .string()
    .transform((v) => v === "true")
    .default("true"),
  GMAIL_SKIP_SOCIAL: z
    .string()
    .transform((v) => v === "true")
    .default("true"),

  // ── Calendar ──────────────────────────────────────────────
  CALENDAR_POLL_INTERVAL_MS: z.coerce.number().default(300000),
  CALENDAR_CACHE_TTL_MS: z.coerce.number().default(180000),
  CALENDAR_ID: z.string().default("primary"),

  // ── GitHub ────────────────────────────────────────────────
  GITHUB_TOKEN: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  GITHUB_NOTIFICATION_CACHE_TTL_MS: z.coerce.number().default(30000),
  GITHUB_SEARCH_CACHE_TTL_MS: z.coerce.number().default(60000),

  // ── Power Automate ────────────────────────────────────────
  PA_OUTLOOK_WEBHOOK_SECRET: z.string().optional(),
  PA_TEAMS_WEBHOOK_SECRET: z.string().optional(),
  PA_DASHBOARD_ORIGIN: z.string().optional(),

  // ── Cloudflare ────────────────────────────────────────────
  CLOUDFLARE_TUNNEL_TOKEN: z.string().optional(),

  // ── VAPID ─────────────────────────────────────────────────
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().optional(),

  // ── Feature Flags ─────────────────────────────────────────
  FEATURE_AUTO_EXECUTE: z
    .string()
    .transform((v) => v === "true")
    .default("false"),
  FEATURE_PUSH_NOTIFICATIONS: z
    .string()
    .transform((v) => v === "true")
    .default("false"),
  FEATURE_CHAT: z
    .string()
    .transform((v) => v === "true")
    .default("true"),
  FEATURE_BACKGROUND_LOOP: z
    .string()
    .transform((v) => v === "true")
    .default("false"),
  FEATURE_FINANCE_STATEMENT_INTAKE: z
    .string()
    .transform((v) => v === "true")
    .default("false"),

  // ── Finance Statement Intake (FIN-001a) ─────────────────
  FINANCE_STATEMENT_SENDER_ALLOWLIST: z
    .string()
    .default("")
    .transform((value) =>
      value
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean)
    ),
  FINANCE_STATEMENT_SUBJECT_KEYWORDS: z
    .string()
    .default("statement")
    .transform((value) =>
      value
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean)
    ),
  FINANCE_STATEMENT_DETECTION_RULE_VERSION: z
    .string()
    .default("fin-001a-v1"),

  // ── Processing Loop ──────────────────────────────────────
  PROCESSING_BATCH_SIZE: z.coerce.number().default(10),
  PROCESSING_INITIAL_BATCH_SIZE: z.coerce.number().default(3),
  PROCESSING_MAX_DURATION_MS: z.coerce.number().default(120_000),
  PROCESSING_MAX_CONSECUTIVE_ERRORS: z.coerce.number().default(5),
  PROCESSING_BACKOFF_MULTIPLIER: z.coerce.number().default(2),
  PROCESSING_MAX_BACKOFF_MS: z.coerce.number().default(300_000),
  MAX_USERS_PER_TICK: z.coerce.number().default(5),
  LLM_DAILY_CALL_LIMIT: z.coerce.number().default(200),

  // ── Circuit Breaker ───────────────────────────────────────
  CB_FAILURE_THRESHOLD: z.coerce.number().default(5),
  CB_RESET_TIMEOUT_MS: z.coerce.number().default(60000),

  // ── Logging ───────────────────────────────────────────────
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
}).superRefine((data, ctx) => {
  // In production, OAUTH_TOKEN_ENCRYPTION_KEY is mandatory — tokens must never
  // be stored unencrypted.
  if (data.NODE_ENV === "production" && !data.OAUTH_TOKEN_ENCRYPTION_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["OAUTH_TOKEN_ENCRYPTION_KEY"],
      message:
        "OAUTH_TOKEN_ENCRYPTION_KEY is required in production (min 32 chars). " +
        "Generate with: openssl rand -base64 32",
    });
  }

  // ── DeepSeek fail-fast: any DeepSeek provider requires API key + explicit model IDs ──
  const needsDeepSeek =
    data.LLM_PROVIDER === "deepseek" ||
    data.LLM_SHADOW_PROVIDER === "deepseek" ||
    data.LLM_REASONING_PROVIDER_PREMIUM === "deepseek";

  if (needsDeepSeek && !data.DEEPSEEK_API_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["DEEPSEEK_API_KEY"],
      message:
        "DEEPSEEK_API_KEY is required when any LLM provider is set to 'deepseek'.",
    });
  }

  if (needsDeepSeek && !data.DEEPSEEK_CLASSIFIER_MODEL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["DEEPSEEK_CLASSIFIER_MODEL"],
      message:
        "DEEPSEEK_CLASSIFIER_MODEL must be set explicitly when using DeepSeek " +
        "(no default). E.g. deepseek-chat",
    });
  }

  if (needsDeepSeek && !data.DEEPSEEK_SYNTHESIS_MODEL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["DEEPSEEK_SYNTHESIS_MODEL"],
      message:
        "DEEPSEEK_SYNTHESIS_MODEL must be set explicitly when using DeepSeek " +
        "(no default). E.g. deepseek-reasoner",
    });
  }
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const formatted = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Environment validation failed:\n${formatted}`);
  }

  return result.data;
}
