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
import { createInboxRouter } from "./inbox.route.js";
import { createActionsRouter } from "./actions.route.js";
import { createTodayRouter } from "./today.route.js";
import { createCycleRouter } from "./cycle.route.js";
import { createStatusRouter } from "./status.route.js";
import { createOAuthRouter } from "./oauth.route.js";
import { createIntegrationsRouter } from "./integrations.route.js";
import { createUsersRouter } from "./users.route.js";
import { createTokenAuthMiddleware } from "../middleware/auth.js";
import { createSessionAuthMiddleware } from "../middleware/session-auth.js";
import { requireUser } from "../middleware/require-user.js";
import { StructuredLogger } from "@oneon/infrastructure";
import type { RequestHandler } from "express";
import {
  createToolRegistry,
  createListInboxTool,
  createSearchEmailsTool,
  createListDeadlinesTool,
  createListCalendarEventsTool,
  createCreateCalendarEventTool,
  createUpdateCalendarEventTool,
  createSearchCalendarTool,
  createListGitHubNotificationsTool,
  createListGitHubPRsTool,
  createListPendingActionsTool,
  createListFollowUpsTool,
  createDailyBriefingTool,
  createListNotificationsTool,
  createListUrgentItemsTool,
  createSearchTeamsMessagesTool,
} from "@oneon/application";

export function registerRoutes(app: Express, container: AppContainer): void {
  const { env } = container;

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
      actionLogRepo: container.actionLogRepo,
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

    // Calendar tools (only if calendarPort available)
    if (container.calendarPort) {
      toolRegistry.register(createListCalendarEventsTool({
        calendarPort: container.calendarPort,
      }));
      toolRegistry.register(createCreateCalendarEventTool({
        calendarPort: container.calendarPort,
      }));
      toolRegistry.register(createUpdateCalendarEventTool({
        calendarPort: container.calendarPort,
      }));
      toolRegistry.register(createSearchCalendarTool({
        calendarPort: container.calendarPort,
      }));
    }

    // GitHub tools (only if githubPort available)
    if (container.githubPort) {
      toolRegistry.register(createListGitHubNotificationsTool({
        githubPort: container.githubPort,
      }));
      toolRegistry.register(createListGitHubPRsTool({
        githubPort: container.githubPort,
      }));
    }

    // Teams tools (only if teamsPort available)
    if (container.teamsPort) {
      toolRegistry.register(createSearchTeamsMessagesTool({
        teamsPort: container.teamsPort,
      }));
    }

    // Daily briefing (requires synthesizer)
    if (container.llmPort) {
      toolRegistry.register(createDailyBriefingTool({
        classificationRepo: container.classificationRepo,
        inboundItemRepo: container.inboundItemRepo,
        deadlineRepo: container.deadlineRepo,
        actionLogRepo: container.actionLogRepo,
        synthesizer: container.llmPort,
        calendarPort: container.calendarPort ?? undefined,
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
        userProfileRepo: container.userProfileRepo,
        intentExtractor: container.llmPort,
        synthesizer: container.llmPort,
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

  // ── Finance Statement Intake (read-only) ────────────────
  if (env.FEATURE_FINANCE_STATEMENT_INTAKE) {
    const financeLogger = new StructuredLogger("finance-statements", env.LOG_LEVEL);
    app.use(
      "/api/finance/statements",
      ...userAuth,
      createFinanceStatementsRouter({
        bankStatementRepo: container.bankStatementRepo,
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
      actionLogRepo: container.actionLogRepo,
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
      actionLogRepo: container.actionLogRepo,
      inboundItemRepo: container.inboundItemRepo,
      logger: actionsLogger,
    }),
  );
  actionsLogger.info("Actions routes registered at /api/actions");

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
      actionLogRepo: container.actionLogRepo,
      notificationRepo: container.notificationRepo,
      calendarPort: container.calendarPort,
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
