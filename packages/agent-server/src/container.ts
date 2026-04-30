import type Database from "better-sqlite3";
import type {
  InboundItemRepository,
  ClassificationRepository,
  ClassificationFeedbackRepository,
  DeadlineRepository,
  ActionLogRepository,
  NotificationRepository,
  ConversationRepository,
  PreferenceRepository,
  BankStatementRepository,
  UserRepository,
  UserProfileRepository,
  OAuthTokenRepository,
  LLMPort,
  CalendarPort,
  GitHubPort,
  TeamsPort,
  NotificationPort,
  TransactionRunner,
  Logger,
} from "@oneon/domain";

import {
  createDatabase,
  runMigrations,
  SqliteInboundItemRepository,
  SqliteClassificationRepository,
  SqliteClassificationFeedbackRepository,
  SqliteDeadlineRepository,
  SqliteActionLogRepository,
  SqliteNotificationRepository,
  SqliteConversationRepository,
  SqlitePreferenceRepository,
  SqliteBankStatementRepository,
  SqliteUserRepository,
  SqliteUserProfileRepository,
  SqliteOAuthTokenRepository,
  SqliteTransactionRunner,
  ClaudeClassifierAdapter,
  DeepSeekClassifierAdapter,
  ShadowLlmAdapter,
  RoutingLlmAdapter,
  StructuredLogger,
  EnvRefreshTokenProvider,
  DbGoogleTokenProvider,
  TTLCache,
  GCalHttpClient,
  GoogleCalendarAdapter,
  GCAL_REQUIRED_SCOPES,
  GitHubHttpClient,
  GitHubAdapter,
  InAppNotificationAdapter,
  TokenCipher,
} from "@oneon/infrastructure";

import type { Env } from "./config/env.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { BackgroundLoop } from "./background-loop.js";

export interface AppContainer {
  // ── Config ────────────────────────────────────────────────
  env: Env;

  // ── Database ──────────────────────────────────────────────
  db: Database.Database;

  // ── Repositories ──────────────────────────────────────────
  inboundItemRepo: InboundItemRepository;
  classificationRepo: ClassificationRepository;
  classificationFeedbackRepo: ClassificationFeedbackRepository;
  deadlineRepo: DeadlineRepository;
  actionLogRepo: ActionLogRepository;
  notificationRepo: NotificationRepository;
  conversationRepo: ConversationRepository;
  preferenceRepo: PreferenceRepository;
  bankStatementRepo: BankStatementRepository;
  userRepo: UserRepository | null;
  userProfileRepo: UserProfileRepository;
  oauthTokenRepo: OAuthTokenRepository | null;

  // ── External Ports ────────────────────────────────────────
  llmPort: LLMPort | null;
  calendarPort: CalendarPort | null;
  githubPort: GitHubPort | null;
  teamsPort: TeamsPort | null;
  notificationPort: NotificationPort;

  // ── Per-User Factories ────────────────────────────────────
  /** True when GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET are configured */
  hasGoogleCredentials: boolean;
  /** Returns userIds that have a DB-stored Google OAuth token (queried at runtime) */
  getEligibleUsers: () => string[];
  /** Creates a per-user DbGoogleTokenProvider, or null if missing creds/token */
  createGoogleTokenProvider: (userId: string) => import("@oneon/infrastructure").TokenProvider | null;

  // ── Infrastructure Services ───────────────────────────────
  transactionRunner: TransactionRunner;

  // ── Background Loop (mutable, set after creation) ─────────
  backgroundLoop: BackgroundLoop | null;

  // ── Logger ────────────────────────────────────────────────
  logger: Logger;

  // ── Cleanup ───────────────────────────────────────────────
  shutdown(): void;
}

export function createContainer(env: Env): AppContainer {
  const logger = new StructuredLogger("boot", env.LOG_LEVEL);

  // ── Database ──────────────────────────────────────────────
  mkdirSync(dirname(env.DATABASE_PATH), { recursive: true });
  const db = createDatabase(env.DATABASE_PATH);
  runMigrations(db);
  logger.info("Database ready", { path: env.DATABASE_PATH });

  // ── Repositories ──────────────────────────────────────────
  const inboundItemRepo = new SqliteInboundItemRepository(db);
  const classificationRepo = new SqliteClassificationRepository(db);
  const classificationFeedbackRepo =
    new SqliteClassificationFeedbackRepository(db);
  const deadlineRepo = new SqliteDeadlineRepository(db);
  const actionLogRepo = new SqliteActionLogRepository(db);
  const notificationRepo = new SqliteNotificationRepository(db);
  const conversationRepo = new SqliteConversationRepository(db);
  const preferenceRepo = new SqlitePreferenceRepository(db);
  const bankStatementRepo = new SqliteBankStatementRepository(db);
  const userProfileRepo = new SqliteUserProfileRepository(db);

  // ── OAuth Repositories (requires OAUTH_TOKEN_ENCRYPTION_KEY) ──
  let userRepo: UserRepository | null = null;
  let oauthTokenRepo: OAuthTokenRepository | null = null;
  let tokenCipher: TokenCipher | null = null;

  if (env.OAUTH_TOKEN_ENCRYPTION_KEY) {
    tokenCipher = new TokenCipher(env.OAUTH_TOKEN_ENCRYPTION_KEY);
    userRepo = new SqliteUserRepository(db);
    oauthTokenRepo = new SqliteOAuthTokenRepository(db, tokenCipher);
    logger.info("OAuth: ✓ token encryption enabled");
  } else {
    logger.warn("OAuth: ✗ DB token storage disabled (missing OAUTH_TOKEN_ENCRYPTION_KEY)");
  }

  // ── Infrastructure Services ───────────────────────────────
  const transactionRunner = new SqliteTransactionRunner(db);

  // ── External Adapters (progressive feature flags) ─────────
  // Each adapter checks its required env vars.
  // Missing config = adapter disabled (null).

  // Google token provider: DB-backed → env-backed → null
  // DB token provider needs a known userId; we use 'primary' user from DB at boot.
  // The actual per-user provider is created on-demand in routes.
  // For the background loop, we pick the first user with a Google token.
  const hasGoogleClientCreds = !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  const hasEnvRefreshToken = !!(hasGoogleClientCreds && env.GOOGLE_REFRESH_TOKEN);

  let tokenProvider: import("@oneon/infrastructure").TokenProvider | null = null;

  if (hasGoogleClientCreds && oauthTokenRepo) {
    // Check if any user has a DB-stored Google token
    // We'll create the actual provider lazily per-user in routes,
    // but for the background loop we try to find a primary user's token
    const allUsers = userRepo!.list();
    const primaryUser = allUsers.length > 0 ? allUsers[0] : null;
    const dbGoogleToken = primaryUser
      ? oauthTokenRepo.get("google", primaryUser.id)
      : null;

    if (dbGoogleToken) {
      tokenProvider = new DbGoogleTokenProvider(
        oauthTokenRepo,
        env.GOOGLE_CLIENT_ID!,
        env.GOOGLE_CLIENT_SECRET!,
        primaryUser!.id,
      );
      logger.info("Google: ✓ active (DB token)", {
        user: dbGoogleToken.providerEmail ?? primaryUser!.email,
      });
    } else if (hasEnvRefreshToken) {
      tokenProvider = new EnvRefreshTokenProvider({
        clientId: env.GOOGLE_CLIENT_ID!,
        clientSecret: env.GOOGLE_CLIENT_SECRET!,
        refreshToken: env.GOOGLE_REFRESH_TOKEN!,
      });
      logger.info("Google: ✓ active (env token)");
    } else {
      logger.warn("Google: ✗ disabled (no DB token and no GOOGLE_REFRESH_TOKEN)");
    }
  } else if (hasEnvRefreshToken) {
    tokenProvider = new EnvRefreshTokenProvider({
      clientId: env.GOOGLE_CLIENT_ID!,
      clientSecret: env.GOOGLE_CLIENT_SECRET!,
      refreshToken: env.GOOGLE_REFRESH_TOKEN!,
    });
    logger.info("Google: ✓ active (env token, no encryption key)");
  } else {
    logger.warn("Google: ✗ disabled (missing Google credentials or refresh token)");
  }

  // ── Per-User Factories (for background loop) ──────────────
  // getEligibleUsers: queries userRepo + oauthTokenRepo at runtime
  // createGoogleTokenProvider: creates DbGoogleTokenProvider for a userId

  const getEligibleUsers = (): string[] => {
    if (!userRepo || !oauthTokenRepo || !hasGoogleClientCreds) return [];
    const users = userRepo.list();
    return users
      .filter((u) => oauthTokenRepo!.get("google", u.id) !== null)
      .map((u) => u.id);
  };

  const createGoogleTokenProvider = (
    userId: string,
  ): import("@oneon/infrastructure").TokenProvider | null => {
    if (!hasGoogleClientCreds || !oauthTokenRepo) return null;
    const dbToken = oauthTokenRepo.get("google", userId);
    if (!dbToken) return null;
    return new DbGoogleTokenProvider(
      oauthTokenRepo,
      env.GOOGLE_CLIENT_ID!,
      env.GOOGLE_CLIENT_SECRET!,
      userId,
    );
  };

  let llmPort: LLMPort | null = null;

  // ── LLM Provider Factory ───────────────────────────────────
  function buildLlmAdapter(provider: "anthropic" | "deepseek"): LLMPort | null {
    if (provider === "anthropic") {
      if (!env.ANTHROPIC_API_KEY) return null;
      return new ClaudeClassifierAdapter({
        apiKey: env.ANTHROPIC_API_KEY,
        classifierModel: env.LLM_CLASSIFIER_MODEL,
        synthesisModel: env.LLM_SYNTHESIS_MODEL,
        maxRetries: env.LLM_MAX_RETRIES,
        timeoutMs: env.LLM_TIMEOUT_MS,
        circuitBreaker: {
          failureThreshold: env.CB_FAILURE_THRESHOLD,
          resetTimeoutMs: env.CB_RESET_TIMEOUT_MS,
        },
        logger,
      });
    }
    if (provider === "deepseek") {
      // DEEPSEEK_API_KEY + model IDs are guaranteed present by env superRefine
      return new DeepSeekClassifierAdapter({
        apiKey: env.DEEPSEEK_API_KEY!,
        classifierModel: env.DEEPSEEK_CLASSIFIER_MODEL!,
        synthesisModel: env.DEEPSEEK_SYNTHESIS_MODEL!,
        maxRetries: env.LLM_MAX_RETRIES,
        classifierTimeoutMs: env.LLM_CLASSIFIER_TIMEOUT_MS,
        synthesisTimeoutMs: env.LLM_SYNTHESIS_TIMEOUT_MS,
        circuitBreaker: {
          failureThreshold: env.CB_FAILURE_THRESHOLD,
          resetTimeoutMs: env.CB_RESET_TIMEOUT_MS,
        },
        logger,
      });
    }
    return null;
  }

  // Primary adapter
  const primaryAdapter = buildLlmAdapter(env.LLM_PROVIDER);

  if (primaryAdapter) {
    llmPort = primaryAdapter;

    // Premium reasoning provider for synthesize() calls
    if (env.LLM_REASONING_PROVIDER_PREMIUM !== "none") {
      const reasoningAdapter = buildLlmAdapter(
        env.LLM_REASONING_PROVIDER_PREMIUM as "anthropic" | "deepseek",
      );
      if (reasoningAdapter) {
        llmPort = new RoutingLlmAdapter({ standard: llmPort, reasoning: reasoningAdapter });
        logger.info("LLM: ✓ premium routing enabled", {
          reasoning: env.LLM_REASONING_PROVIDER_PREMIUM,
        });
      }
    }

    // Shadow harness for A/B comparison (fire-and-forget)
    if (env.LLM_SHADOW_PROVIDER !== "none") {
      const shadowAdapter = buildLlmAdapter(
        env.LLM_SHADOW_PROVIDER as "anthropic" | "deepseek",
      );
      if (shadowAdapter) {
        llmPort = new ShadowLlmAdapter({ primary: llmPort, shadow: shadowAdapter, logger });
        logger.info("LLM: ✓ shadow mode enabled", {
          shadowProvider: env.LLM_SHADOW_PROVIDER,
        });
      }
    }

    logger.info("LLM: ✓ active", {
      provider: env.LLM_PROVIDER,
      classifier: env.LLM_PROVIDER === "deepseek" ? env.DEEPSEEK_CLASSIFIER_MODEL : env.LLM_CLASSIFIER_MODEL,
      synthesis: env.LLM_PROVIDER === "deepseek" ? env.DEEPSEEK_SYNTHESIS_MODEL : env.LLM_SYNTHESIS_MODEL,
    });
  } else {
    logger.warn("LLM: ✗ disabled", {
      provider: env.LLM_PROVIDER,
      reason: env.LLM_PROVIDER === "anthropic" ? "missing ANTHROPIC_API_KEY" : "missing DEEPSEEK_API_KEY",
    });
  }

  let calendarPort: CalendarPort | null = null;
  if (tokenProvider) {
    const gcalClient = new GCalHttpClient(tokenProvider);
    const calendarCache = new TTLCache<import("@oneon/domain").CalendarEvent[]>();
    calendarPort = new GoogleCalendarAdapter({
      client: gcalClient,
      calendarId: env.CALENDAR_ID,
      cache: calendarCache,
      cacheTtlMs: env.CALENDAR_CACHE_TTL_MS,
    });
    logger.info("Calendar: ✓ active", {
      calendarId: env.CALENDAR_ID,
      cacheTtlMs: env.CALENDAR_CACHE_TTL_MS,
      requiredScopes: GCAL_REQUIRED_SCOPES,
    });
    logger.warn(
      "Calendar: ensure your Google OAuth refresh token was granted with Calendar scopes. " +
      "If you added Calendar scopes after initial consent, you must re-consent to obtain a new refresh token.",
    );
  } else {
    logger.warn("Calendar: ✗ disabled (missing Google credentials or refresh token)");
  }

  let githubPort: GitHubPort | null = null;
  // GitHub: DB token → env token → null
  let githubToken: string | null = null;
  if (oauthTokenRepo && userRepo) {
    const allUsers = userRepo.list();
    const primaryUser = allUsers.length > 0 ? allUsers[0] : null;
    const dbGitHubToken = primaryUser
      ? oauthTokenRepo.get("github", primaryUser.id)
      : null;
    if (dbGitHubToken) {
      githubToken = dbGitHubToken.accessToken;
      logger.info("GitHub: ✓ active (DB token)", {
        user: dbGitHubToken.providerEmail ?? primaryUser!.email,
      });
    }
  }
  if (!githubToken && env.GITHUB_TOKEN) {
    githubToken = env.GITHUB_TOKEN;
    logger.info("GitHub: ✓ active (env token)");
  }
  if (githubToken) {
    const githubClient = new GitHubHttpClient(githubToken);
    const notificationCache = new TTLCache<import("@oneon/domain").GitHubNotification[]>();
    const searchCache = new TTLCache<import("@oneon/domain").GitHubPullRequest[]>();
    githubPort = new GitHubAdapter({
      client: githubClient,
      notificationCache,
      searchCache,
      notificationCacheTtlMs: env.GITHUB_NOTIFICATION_CACHE_TTL_MS,
      searchCacheTtlMs: env.GITHUB_SEARCH_CACHE_TTL_MS,
    });
  } else {
    logger.warn("GitHub: ✗ disabled (no DB token and no GITHUB_TOKEN env var)");
  }

  const notificationPort: NotificationPort = new InAppNotificationAdapter({
    notificationRepo,
    preferenceRepo,
    logger,
  });
  logger.info("Notifications: ✓ in-app mode");

  // ── Power Automate status ─────────────────────────────────
  if (env.PA_OUTLOOK_WEBHOOK_SECRET) {
    logger.info("Outlook (PA): ✓ webhook ready");
  } else {
    logger.warn("Outlook (PA): ✗ disabled (missing PA_OUTLOOK_WEBHOOK_SECRET)");
  }

  if (env.PA_TEAMS_WEBHOOK_SECRET) {
    logger.info("Teams (PA): ✓ webhook ready");
  } else {
    logger.warn("Teams (PA): ✗ disabled (missing PA_TEAMS_WEBHOOK_SECRET)");
  }

  // ── Shutdown ──────────────────────────────────────────────
  function shutdown(): void {
    logger.info("Shutting down...");
    db.close();
    logger.info("Database connection closed");
  }

  return {
    env,
    db,
    inboundItemRepo,
    classificationRepo,
    classificationFeedbackRepo,
    deadlineRepo,
    actionLogRepo,
    notificationRepo,
    conversationRepo,
    preferenceRepo,
    bankStatementRepo,
    userRepo,
    userProfileRepo,
    oauthTokenRepo,
    hasGoogleCredentials: hasGoogleClientCreds,
    getEligibleUsers,
    createGoogleTokenProvider,
    llmPort,
    calendarPort,
    githubPort,
    teamsPort: null, // No Teams adapter yet — will be wired when Graph API integration is added
    notificationPort,
    transactionRunner,
    backgroundLoop: null,
    logger,
    shutdown,
  };
}
