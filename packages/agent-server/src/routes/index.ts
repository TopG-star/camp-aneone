import type { Express } from "express";
import type { AppContainer } from "../container.js";
import rateLimit from "express-rate-limit";
import { createOutlookWebhookRouter } from "./outlook-webhook.route.js";
import { createGitHubWebhookRouter } from "./github-webhook.route.js";
import { createTeamsWebhookRouter } from "./teams-webhook.route.js";
import { createChatRouter } from "./chat.route.js";
import { createDeadlinesRouter } from "./deadlines.route.js";
import { createNotificationRouter } from "./notification.route.js";
import { createNotificationPreferencesRouter } from "./notification-preferences.route.js";
import { createProfileRouter } from "./profile.route.js";
import { createFinanceStatementsRouter } from "./finance-statements.route.js";
import { createDevFinanceRouter } from "./dev-finance.route.js";
import { createInboxRouter } from "./inbox.route.js";
import { createActionsRouter } from "./actions.route.js";
import { createActionDefinitionsRouter } from "./action-definitions.route.js";
import { createAiDataRouter } from "./ai-data.route.js";
import { createTodayRouter } from "./today.route.js";
import { createCycleRouter } from "./cycle.route.js";
import { createStatusRouter } from "./status.route.js";
import { createOAuthRouter } from "./oauth.route.js";
import { createIntegrationsRouter } from "./integrations.route.js";
import { createPushSubscriptionsRouter } from "./push-subscriptions.route.js";
import { createUsersRouter } from "./users.route.js";
import { createMemoryRouter } from "./memory.route.js";
import { createTokenAuthMiddleware } from "../middleware/auth.js";
import { createSessionAuthMiddleware } from "../middleware/session-auth.js";
import { requireUser } from "../middleware/require-user.js";
import {
  LocalDocMemoryProvider,
  StructuredLogger,
  TTLCache,
  GitHubHttpClient,
  GitHubAdapter,
} from "@oneon/infrastructure";
import type { RequestHandler } from "express";
import type { GitHubNotification, GitHubPullRequest } from "@oneon/domain";
import {
  createToolRegistry,
  createListInboxTool,
  createSearchEmailsTool,
  createListDeadlinesTool,
  createListCalendarEventsTool,
  createSearchCalendarTool,
  createListGitHubNotificationsTool,
  createListGitHubPRsTool,
  createListPendingActionsTool,
  createListFollowUpsTool,
  createDailyBriefingTool,
  createListNotificationsTool,
  createListUrgentItemsTool,
  createSearchTeamsMessagesTool,
  createFinanceStatementStatusTool,
  createSearchFinanceTransactionsTool,
  createTopFinanceTransactionsTool,
  createSummarizeFinanceSpendTool,
  createFinanceSpendInsightsTool,
  createSearchPersonalMemoryTool,
  createChatActionTools,
} from "@oneon/application";

export function registerRoutes(app: Express, container: AppContainer): void {
  const { env } = container;
  const docMemoryProvider = env.FEATURE_PERSONAL_MEMORY
    ? new LocalDocMemoryProvider({
        roots: env.MEMORY_DOC_ROOTS,
        maxFiles: env.MEMORY_DOC_MAX_FILES,
      })
    : null;

  // ── Auth middleware ─────────────────────────────────────────
  //
  // Session auth (browser routes): cookie-based, auto-upserts user on first request
  // Token auth (system/webhook routes): Bearer token for admin scripts, CI, etc.
  // These are NOT chained — each route group uses exactly one strategy.

  const sessionAuth = createSessionAuthMiddleware(
    env.NEXTAUTH_SECRET,
    (email) => container.userRepo?.findByEmail(email) ?? null,
    container.userRepo
      ? (user) => container.userRepo!.upsert(user)
      : undefined,
  );
  const tokenAuth = createTokenAuthMiddleware(env.API_TOKEN);

  // Browser routes: session cookie + require userId
  const userAuth: RequestHandler[] = [sessionAuth, requireUser];

  // System routes: Bearer token only (admin scripts, CI triggers)
  const systemAuth: RequestHandler[] = [tokenAuth];

  // One calendar adapter (and cache) per user, shared with the action executors, so a
  // calendar write is visible to chat reads and Today without waiting for the cache TTL.
  const resolveCalendarPort = (userId: string) => container.actions.calendarReaderFor(userId);

  // ── Webhook user resolution ───────────────────────────────
  // For MVP: if exactly one user exists, assign webhook items to them.
  // Multi-user: returns null → items created with userId=null (unassigned).
  // Future: per-user webhook secrets via path-based routing (/api/webhooks/:userId/...).
  const resolveWebhookUserId = (): string | null => {
    if (!container.userRepo) return null;
    const users = container.userRepo.list();
    if (users.length > 1) {
      container.logger.warn(
        "Multiple users detected — webhook items will be unassigned. " +
        "Configure per-user webhook routing for multi-user deployments.",
        { userCount: users.length },
      );
    }
    return users.length === 1 ? users[0].id : null;
  };

  // ── Webhook routes (own HMAC auth, no token gate) ─────────

  // ── Outlook Power Automate Webhook ────────────────────────
  if (env.PA_OUTLOOK_WEBHOOK_SECRET) {
    const outlookLogger = new StructuredLogger(
      "outlook-webhook",
      env.LOG_LEVEL
    );
    app.use(
      "/api/webhooks/outlook",
      createOutlookWebhookRouter({
        inboundItemRepo: container.inboundItemRepo,
        webhookSecret: env.PA_OUTLOOK_WEBHOOK_SECRET,
        logger: outlookLogger,
        resolveUserId: resolveWebhookUserId,
      })
    );
    outlookLogger.info("Outlook webhook route registered at /api/webhooks/outlook");
  }

  // ── GitHub Webhook ────────────────────────────────────────
  if (env.GITHUB_WEBHOOK_SECRET) {
    const githubLogger = new StructuredLogger(
      "github-webhook",
      env.LOG_LEVEL
    );
    app.use(
      "/api/webhooks/github",
      createGitHubWebhookRouter({
        inboundItemRepo: container.inboundItemRepo,
        webhookSecret: env.GITHUB_WEBHOOK_SECRET,
        logger: githubLogger,
        resolveUserId: resolveWebhookUserId,
      })
    );
    githubLogger.info("GitHub webhook route registered at /api/webhooks/github");
  }

  // ── Teams Power Automate Webhook ──────────────────────────
  if (env.PA_TEAMS_WEBHOOK_SECRET) {
    const teamsLogger = new StructuredLogger("teams-webhook", env.LOG_LEVEL);
    app.use(
      "/api/webhooks/teams",
      createTeamsWebhookRouter({
        inboundItemRepo: container.inboundItemRepo,
        webhookSecret: env.PA_TEAMS_WEBHOOK_SECRET,
        logger: teamsLogger,
        resolveUserId: resolveWebhookUserId,
      }),
    );
    teamsLogger.info("Teams webhook route registered at /api/webhooks/teams");
  }

  // ── Chat Endpoint ─────────────────────────────────────────
  if (env.FEATURE_CHAT) {
    const chatLogger = new StructuredLogger("chat", env.LOG_LEVEL);
    const githubPortByUser = new Map<
      string,
      {
        accessToken: string;
        port: NonNullable<typeof container.githubPort>;
      }
    >();
    const resolveGitHubPort = (userId: string) => {
      if (!container.oauthTokenRepo) {
        return null;
      }

      const token = container.oauthTokenRepo.get("github", userId);
      if (!token) {
        githubPortByUser.delete(userId);
        return null;
      }

      const cached = githubPortByUser.get(userId);
      if (cached && cached.accessToken === token.accessToken) {
        return cached.port;
      }

      const port = new GitHubAdapter({
        client: new GitHubHttpClient(token.accessToken),
        notificationCache: new TTLCache<GitHubNotification[]>(),
        searchCache: new TTLCache<GitHubPullRequest[]>(),
        notificationCacheTtlMs: env.GITHUB_NOTIFICATION_CACHE_TTL_MS,
        searchCacheTtlMs: env.GITHUB_SEARCH_CACHE_TTL_MS,
      });

      githubPortByUser.set(userId, {
        accessToken: token.accessToken,
        port,
      });
      return port;
    };


    // Build tool registry with all available tools
    const toolRegistry = createToolRegistry();

    // Core tools (always available)
    toolRegistry.register(createListInboxTool({
      inboundItemRepo: container.inboundItemRepo,
      classificationRepo: container.classificationRepo,
    }));
    toolRegistry.register(createSearchEmailsTool({
      inboundItemRepo: container.inboundItemRepo,
      classificationRepo: container.classificationRepo,
    }));
    toolRegistry.register(createListDeadlinesTool({
      deadlineRepo: container.deadlineRepo,
    }));
    toolRegistry.register(createListPendingActionsTool({
      instanceRepo: container.actions.instanceRepo,
      registry: container.actions.registry,
    }));
    toolRegistry.register(createListFollowUpsTool({
      classificationRepo: container.classificationRepo,
      inboundItemRepo: container.inboundItemRepo,
    }));
    toolRegistry.register(createListUrgentItemsTool({
      classificationRepo: container.classificationRepo,
      inboundItemRepo: container.inboundItemRepo,
    }));
    toolRegistry.register(createListNotificationsTool({
      notificationRepo: container.notificationRepo,
    }));
    if (env.FEATURE_PERSONAL_MEMORY) {
      toolRegistry.register(createSearchPersonalMemoryTool({
        personalMemoryNoteRepo: container.personalMemoryNoteRepo,
        personalMemoryPinRepo: container.personalMemoryPinRepo,
        docMemoryProvider,
      }));
    }

    // Finance tools (only when finance intake feature is enabled)
    if (env.FEATURE_FINANCE_STATEMENT_INTAKE) {
      toolRegistry.register(createFinanceStatementStatusTool({
        bankStatementRepo: container.bankStatementRepo,
      }));
      toolRegistry.register(createSearchFinanceTransactionsTool({
        bankStatementRepo: container.bankStatementRepo,
        bankStatementParseRepo: container.bankStatementParseRepo,
      }));
      toolRegistry.register(createTopFinanceTransactionsTool({
        bankStatementRepo: container.bankStatementRepo,
        bankStatementParseRepo: container.bankStatementParseRepo,
      }));
      toolRegistry.register(createSummarizeFinanceSpendTool({
        bankStatementRepo: container.bankStatementRepo,
        bankStatementParseRepo: container.bankStatementParseRepo,
      }));
      toolRegistry.register(createFinanceSpendInsightsTool({
        bankStatementRepo: container.bankStatementRepo,
        bankStatementParseRepo: container.bankStatementParseRepo,
      }));
    }


    // Calendar read tools: registered even without the env-token port, because
    // resolveCalendarPort serves each signed-in user's own calendar (OAuth-only deployments).
    toolRegistry.register(createListCalendarEventsTool({
      calendarPort: container.calendarPort ?? undefined,
      resolveCalendarPort,
    }));
    toolRegistry.register(createSearchCalendarTool({
      calendarPort: container.calendarPort ?? undefined,
      resolveCalendarPort,
    }));

    // Chat action tools: writes go through the action framework, so they are
    // registered even without a calendar port and fail honestly when it is missing.
    const aiModel =
      env.LLM_PROVIDER === "deepseek"
        ? `deepseek:${env.DEEPSEEK_CLASSIFIER_MODEL ?? "unknown"}`
        : `anthropic:${env.LLM_CLASSIFIER_MODEL}`;
    for (const tool of createChatActionTools({
      requestAction: container.actions.orchestrator.requestAction,
      registry: container.actions.registry,
      aiModel,
      clock: () => new Date(),
    })) {
      toolRegistry.register(tool);
    }

    // GitHub tools (only if githubPort available)
    if (container.githubPort) {
      toolRegistry.register(createListGitHubNotificationsTool({
        githubPort: container.githubPort,
        resolveGitHubPort,
      } as Parameters<typeof createListGitHubNotificationsTool>[0]));
      toolRegistry.register(createListGitHubPRsTool({
        githubPort: container.githubPort,
        resolveGitHubPort,
      } as Parameters<typeof createListGitHubPRsTool>[0]));
    }

    // Teams tools (only if teamsPort available)
    if (container.teamsPort) {
      toolRegistry.register(createSearchTeamsMessagesTool({
        teamsPort: container.teamsPort,
      }));
    }

    // Daily briefing (requires the model gateway)
    if (container.modelGateway) {
      toolRegistry.register(createDailyBriefingTool({
        classificationRepo: container.classificationRepo,
        inboundItemRepo: container.inboundItemRepo,
        deadlineRepo: container.deadlineRepo,
        instanceRepo: container.actions.instanceRepo,
        modelGateway: container.modelGateway,
        calendarPort: container.calendarPort ?? undefined,
        resolveCalendarPort,
        logger: chatLogger,
      }));
    }

    const chatLimiter = rateLimit({
      windowMs: 60_000,
      max: 20,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: "Chat rate limit exceeded, please slow down" },
    });

    app.use(
      "/api/chat",
      chatLimiter,
      ...userAuth,
      createChatRouter({
        conversationRepo: container.conversationRepo,
        logger: chatLogger,
        inboundItemRepo: container.inboundItemRepo,
        classificationRepo: container.classificationRepo,
        deadlineRepo: container.deadlineRepo,
        instanceRepo: container.actions.instanceRepo,
        userProfileRepo: container.userProfileRepo,
        modelGateway: container.modelGateway,
        toolRegistry,
      })
    );
    chatLogger.info("Chat route registered at /api/chat", {
      tools: toolRegistry.list().map((t) => t.name),
    });
  }

  // ── Dashboard routes (token-gated) ────────────────────────

  // ── Notifications ─────────────────────────────────────────
  const notifLogger = new StructuredLogger("notifications", env.LOG_LEVEL);
  app.use(
    "/api/notifications",
    ...userAuth,
    createNotificationRouter({
      notificationRepo: container.notificationRepo,
      logger: notifLogger,
    }),
  );
  notifLogger.info("Notification routes registered at /api/notifications");

  // ── Notification Preferences ──────────────────────────────
  const prefLogger = new StructuredLogger("notification-preferences", env.LOG_LEVEL);
  app.use(
    "/api/notification-preferences",
    ...userAuth,
    createNotificationPreferencesRouter({
      preferenceRepo: container.preferenceRepo,
      logger: prefLogger,
    }),
  );
  prefLogger.info("Notification preferences routes registered at /api/notification-preferences");
  if (env.FEATURE_PUSH_NOTIFICATIONS) {
    const pushLogger = new StructuredLogger("push-subscriptions", env.LOG_LEVEL);
    app.use(
      "/api/push",
      ...userAuth,
      createPushSubscriptionsRouter({
        pushSubscriptionRepo: container.pushSubscriptionRepo,
        logger: pushLogger,
        vapidPublicKey: env.VAPID_PUBLIC_KEY ?? null,
      }),
    );
    pushLogger.info("Push subscription routes registered at /api/push");
  }

  // ── User Profile Preferences ─────────────────────────────
  const profileLogger = new StructuredLogger("profile", env.LOG_LEVEL);
  app.use(
    "/api/profile",
    ...userAuth,
    createProfileRouter({
      userProfileRepo: container.userProfileRepo,
      logger: profileLogger,
    }),
  );
  profileLogger.info("Profile routes registered at /api/profile");

  if (env.FEATURE_PERSONAL_MEMORY) {
    const memoryLogger = new StructuredLogger("memory", env.LOG_LEVEL);
    app.use(
      "/api/memory",
      ...userAuth,
      createMemoryRouter({
        personalMemoryNoteRepo: container.personalMemoryNoteRepo,
        personalMemoryPinRepo: container.personalMemoryPinRepo,
        docMemoryProvider,
        logger: memoryLogger,
      }),
    );
    memoryLogger.info("Memory routes registered at /api/memory");
  }

  // ── Finance Statement Intake (read-only) ────────────────
  if (env.FEATURE_FINANCE_STATEMENT_INTAKE) {
    const financeLogger = new StructuredLogger("finance-statements", env.LOG_LEVEL);
    app.use(
      "/api/finance/statements",
      ...userAuth,
      createFinanceStatementsRouter({
        bankStatementRepo: container.bankStatementRepo,
        bankStatementParseRepo: container.bankStatementParseRepo,
        logger: financeLogger,
      }),
    );
    financeLogger.info("Finance statement routes registered at /api/finance/statements");
  }

  // ── Inbox ─────────────────────────────────────────────────
  const inboxLogger = new StructuredLogger("inbox", env.LOG_LEVEL);
  app.use(
    "/api/inbox",
    ...userAuth,
    createInboxRouter({
      inboundItemRepo: container.inboundItemRepo,
      classificationRepo: container.classificationRepo,
      deadlineRepo: container.deadlineRepo,
      instanceRepo: container.actions.instanceRepo,
      logger: inboxLogger,
    }),
  );
  inboxLogger.info("Inbox routes registered at /api/inbox");

  // ── Actions ───────────────────────────────────────────────
  const actionsLogger = new StructuredLogger("actions", env.LOG_LEVEL);
  app.use(
    "/api/actions",
    ...userAuth,
    createActionsRouter({
      orchestrator: container.actions.orchestrator,
      registry: container.actions.registry,
      instanceRepo: container.actions.instanceRepo,
      configRepo: container.actions.configRepo,
      legacyRepo: container.actions.legacyRepo,
      logger: actionsLogger,
    }),
  );
  app.use(
    "/api/action-definitions",
    ...userAuth,
    createActionDefinitionsRouter({
      registry: container.actions.registry,
      configRepo: container.actions.configRepo,
      logger: actionsLogger,
    }),
  );
  actionsLogger.info("Actions routes registered at /api/actions and /api/action-definitions");
  app.use(
    "/api/ai-data",
    ...userAuth,
    createAiDataRouter({
      gateway: container.modelGateway,
      routing: container.modelRouting,
      overrides: container.modelOverrides,
      configuredProviders: container.modelProviders,
      choices: container.aiDataChoices,
      audit: container.modelAudit,
      logger: new StructuredLogger("ai-data", env.LOG_LEVEL),
    }),
  );

  // ── Deadlines ─────────────────────────────────────────────
  const deadlinesLogger = new StructuredLogger("deadlines", env.LOG_LEVEL);
  app.use(
    "/api/deadlines",
    ...userAuth,
    createDeadlinesRouter({
      deadlineRepo: container.deadlineRepo,
      inboundItemRepo: container.inboundItemRepo,
      logger: deadlinesLogger,
    }),
  );
  deadlinesLogger.info("Deadlines routes registered at /api/deadlines");

  // ── Today (aggregated briefing) ───────────────────────────
  const todayLogger = new StructuredLogger("today", env.LOG_LEVEL);
  app.use(
    "/api/today",
    ...userAuth,
    createTodayRouter({
      classificationRepo: container.classificationRepo,
      inboundItemRepo: container.inboundItemRepo,
      deadlineRepo: container.deadlineRepo,
      instanceRepo: container.actions.instanceRepo,
      notificationRepo: container.notificationRepo,
      preferenceRepo: container.preferenceRepo,
      resolveCalendarPort,
      logger: todayLogger,
    }),
  );
  todayLogger.info("Today route registered at /api/today");

  // ── Cycle status & run-now ─────────────────────────────────
  const cycleLogger = new StructuredLogger("cycle", env.LOG_LEVEL);
  app.use(
    "/api/cycle",
    ...userAuth,
    createCycleRouter({
      getBackgroundLoop: () => container.backgroundLoop ?? null,
      instanceRepo: container.actions.instanceRepo,
      logger: cycleLogger,
    }),
  );
  cycleLogger.info("Cycle routes registered at /api/cycle");

  // ── Status (integration overview) ─────────────────────────
  const statusLogger = new StructuredLogger("status", env.LOG_LEVEL);
  app.use(
    "/api/status",
    ...userAuth,
    createStatusRouter({
      container,
      logger: statusLogger,
    }),
  );
  statusLogger.info("Status route registered at /api/status");

  // ── OAuth routes (callback is public, start/disconnect are auth-gated) ──
  if (container.userRepo && container.oauthTokenRepo) {
    const oauthLogger = new StructuredLogger("oauth", env.LOG_LEVEL);

    const oauthLimiter = rateLimit({
      windowMs: 60_000,
      max: 15,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: "OAuth rate limit exceeded, please try again later" },
    });

    // Callback must be public (browser redirect from Google)
    // Session middleware runs first to set req.userId (non-blocking),
    // but does not reject unauthenticated requests. Start/disconnect
    // endpoints check req.userId themselves.
    app.use(
      "/api/oauth",
      oauthLimiter,
      sessionAuth,
      createOAuthRouter({
        userRepo: container.userRepo,
        oauthTokenRepo: container.oauthTokenRepo,
        preferenceRepo: container.preferenceRepo,
        googleClientId: env.GOOGLE_CLIENT_ID ?? "",
        googleClientSecret: env.GOOGLE_CLIENT_SECRET ?? "",
        publicUrl: env.PUBLIC_URL ?? `http://localhost:${env.PORT}`,
        allowedEmails: env.ALLOWED_EMAILS,
        logger: oauthLogger,
      }),
    );
    oauthLogger.info("OAuth routes registered at /api/oauth");

    // ── Integrations (fully auth-gated) ───────────────────────
    const integrationsLogger = new StructuredLogger("integrations", env.LOG_LEVEL);
    app.use(
      "/api/integrations",
      ...userAuth,
      createIntegrationsRouter({
        userRepo: container.userRepo,
        oauthTokenRepo: container.oauthTokenRepo,
        logger: integrationsLogger,
      }),
    );
    integrationsLogger.info("Integrations routes registered at /api/integrations");

    if (env.NODE_ENV !== "production") {
      const devFinanceLogger = new StructuredLogger("dev-finance", env.LOG_LEVEL);
      app.use(
        "/api/dev/finance",
        ...systemAuth,
        createDevFinanceRouter({
          userRepo: container.userRepo,
          bankStatementRepo: container.bankStatementRepo,
          bankStatementParseRepo: container.bankStatementParseRepo,
          bankStatementParserRegistry: container.bankStatementParserRegistry,
          allowedEmails: env.ALLOWED_EMAILS,
          maxTransactionRetries: env.FINANCE_STATEMENT_MAX_TRANSACTION_RETRIES,
          logger: devFinanceLogger,
        }),
      );
      devFinanceLogger.info("Dev finance routes registered at /api/dev/finance");
    }

    // ── Users (system-auth only — for admin scripts) ────────────
    const usersLogger = new StructuredLogger("users", env.LOG_LEVEL);
    app.use(
      "/api/users",
      ...systemAuth,
      createUsersRouter({
        userRepo: container.userRepo,
        logger: usersLogger,
      }),
    );
    usersLogger.info("Users routes registered at /api/users");
  }
}
