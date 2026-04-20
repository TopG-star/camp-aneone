import { config } from "dotenv";
import { resolve } from "node:path";
import express from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";

// Load .env from monorepo root
config({ path: resolve(import.meta.dirname!, "../../..", ".env") });

import { loadEnv } from "./config/env.js";
import { createContainer } from "./container.js";
import { registerRoutes } from "./routes/index.js";
import { BackgroundLoop } from "./background-loop.js";
import { ingestGmail, runProcessingCycle } from "@oneon/application";
import type { DailyCallCounter } from "@oneon/application";
import {
  GmailHttpClient,
  GmailPollingAdapter,
} from "@oneon/infrastructure";

// ── Bootstrap ────────────────────────────────────────────────
const env = loadEnv();
const container = createContainer(env);
const { logger } = container;

// ── Express App ──────────────────────────────────────────────
const app = express();

// ── Security Middleware ──────────────────────────────────────
app.use(helmet({
  hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: false },
}));
app.use(cors({
  origin: env.PA_DASHBOARD_ORIGIN ?? "http://localhost:3000",
  credentials: true,
}));
app.use(rateLimit({
  windowMs: 60_000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
}));
app.disable("x-powered-by");
app.use(express.json({
  verify: (req, _res, buf) => {
    (req as unknown as { rawBody: Buffer }).rawBody = buf;
  },
}));

app.use(cookieParser());

app.get("/health", (_req, res) => {
  const health = {
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    features: {
      ingestion: container.hasGoogleCredentials,
      llm: container.llmPort !== null,
      calendar: container.calendarPort !== null,
      github: container.githubPort !== null,
      notifications: container.notificationPort !== null,
    },
  };
  res.json(health);
});

// ── Register Routes ──────────────────────────────────────────
registerRoutes(app, container);

// ── Graceful Shutdown ────────────────────────────────────────
let server: ReturnType<typeof app.listen>;

function handleShutdown(signal: string): void {
  logger.info(`Received ${signal}, shutting down gracefully`);
  if (backgroundLoop) {
    backgroundLoop.stop().then(() => {
      logger.info("Background loop stopped");
    });
  }
  server?.close(() => {
    container.shutdown();
    process.exit(0);
  });
  // Force exit after 5 seconds if server doesn't close
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", () => handleShutdown("SIGINT"));
process.on("SIGTERM", () => handleShutdown("SIGTERM"));

// ── Startup ──────────────────────────────────────────────────
logger.info("Camp-Aneone (Oneon) agent-server starting", {
  nodeEnv: env.NODE_ENV,
  port: env.PORT,
  features: {
    autoExecute: env.FEATURE_AUTO_EXECUTE,
    pushNotifications: env.FEATURE_PUSH_NOTIFICATIONS,
    chat: env.FEATURE_CHAT,
    backgroundLoop: env.FEATURE_BACKGROUND_LOOP,
  },
});

// ── Background Processing Loop ──────────────────────────────
let backgroundLoop: BackgroundLoop | null = null;

if (env.FEATURE_BACKGROUND_LOOP && container.llmPort) {
  // Shared daily LLM call counter (mutable, survives across cycles)
  const dailyCallCounter: DailyCallCounter = {
    date: new Date().toISOString().slice(0, 10),
    count: 0,
  };
  // First cycle uses smaller batch to avoid burst on startup
  let isFirstCycle = true;

  const userCycleRunner = async (userId: string) => {
    // 1. Create per-user Google token provider
    const tokenProvider = container.createGoogleTokenProvider(userId);
    if (!tokenProvider) {
      throw new Error(`No Google token for user ${userId}`);
    }

    // 2. Ingest Gmail for this user
    const gmailClient = new GmailHttpClient(tokenProvider);
    const ingestionPort = new GmailPollingAdapter({
      client: gmailClient,
      preferenceRepo: container.preferenceRepo,
      logger,
      skipConfig: {
        skipPromotions: env.GMAIL_SKIP_PROMOTIONS,
        skipSocial: env.GMAIL_SKIP_SOCIAL,
      },
      maxResults: env.GMAIL_MAX_RESULTS,
    });

    await ingestGmail({
      ingestionPort,
      inboundItemRepo: container.inboundItemRepo,
      logger,
      userId,
    });

    // 3. Run processing cycle for this user
    const batchSize = isFirstCycle
      ? env.PROCESSING_INITIAL_BATCH_SIZE
      : env.PROCESSING_BATCH_SIZE;
    if (isFirstCycle) isFirstCycle = false;

    return runProcessingCycle(
      {
        userId,
        inboundItemRepo: container.inboundItemRepo,
        classificationRepo: container.classificationRepo,
        deadlineRepo: container.deadlineRepo,
        actionLogRepo: container.actionLogRepo,
        transactionRunner: container.transactionRunner,
        llmPort: container.llmPort!,
        logger,
        classifierModel: env.LLM_CLASSIFIER_MODEL,
        promptVersion: "v1",
        maxAttempts: 3,
        skipRules: [
          // FR-008: Skip social media notification senders
          {
            senderPattern: "noreply@(facebook|instagram|twitter|tiktok|reddit|discord|youtube)\\.com",
            category: "newsletter" as const,
            priority: 5 as const,
          },
        ],
        featureAutoExecute: env.FEATURE_AUTO_EXECUTE,
        notificationPort: container.notificationPort,
        notificationRepo: container.notificationRepo,
        dailyCallCounter,
        dailyCallLimit: env.LLM_DAILY_CALL_LIMIT,
      },
      {
        batchSize,
        maxDurationMs: env.PROCESSING_MAX_DURATION_MS,
      },
    );
  };

  backgroundLoop = new BackgroundLoop(
    userCycleRunner,
    container.getEligibleUsers,
    logger,
    {
      intervalMs: env.GMAIL_POLL_INTERVAL_MS,
      batchSize: env.PROCESSING_BATCH_SIZE,
      maxDurationMs: env.PROCESSING_MAX_DURATION_MS,
      maxConsecutiveErrors: env.PROCESSING_MAX_CONSECUTIVE_ERRORS,
      backoffMultiplier: env.PROCESSING_BACKOFF_MULTIPLIER,
      maxBackoffMs: env.PROCESSING_MAX_BACKOFF_MS,
      maxUsersPerTick: env.MAX_USERS_PER_TICK,
    },
  );
  container.backgroundLoop = backgroundLoop;
} else if (env.FEATURE_BACKGROUND_LOOP) {
  logger.warn("Background loop enabled but LLM port unavailable — loop not started");
}

server = app.listen(env.PORT, () => {
  logger.info(`Server ready on port ${env.PORT}`);
  if (backgroundLoop) {
    backgroundLoop.start();
    logger.info("Background processing loop started", {
      intervalMs: env.GMAIL_POLL_INTERVAL_MS,
      batchSize: env.PROCESSING_BATCH_SIZE,
    });
  }
});
