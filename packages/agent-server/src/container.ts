import type Database from "better-sqlite3";
import type {
  InboundItemRepository,
  ClassificationRepository,
  ClassificationFeedbackRepository,
  DeadlineRepository,
  NotificationRepository,
  PreferenceRepository,
  PushSubscriptionRepository,
  BankStatementRepository,
  BankStatementParseRepository,
  BankStatementParserRegistry,
  UserRepository,
  UserProfileRepository,
  OAuthTokenRepository,
  PersonalMemoryNoteRepository,
  PersonalMemoryPinRepository,
  CalendarPort,
  GitHubPort,
  TeamsPort,
  NotificationPort,
  NotificationWriter,
  TransactionRunner,
  Logger,
} from "@oneon/domain";

import {
  openControlDb,
  type ControlDb,
  PlatformOperatorRepository,
  TenantRegistrationRepository,
  EnrolmentService,
  MembershipRepository,
  TenantAiLimitRepository,
  UsedHandoffJti,
  createImpressoRxClient,
  type ImpressoRxClient,
  ContextDbGate,
  rawDb,
  backfillIdentities,
  ensureIdentityForUser,
  ensureIdentityAnchor,
  SqliteIdentityRepository,
  LinkIntentRepository,
  type IdentityRepository,
  SqliteInboundItemRepository,
  SqliteClassificationRepository,
  SqliteClassificationFeedbackRepository,
  SqliteDeadlineRepository,
  SqliteNotificationRepository,
  SqlitePreferenceRepository,
  SqlitePushSubscriptionRepository,
  SqliteBankStatementRepository,
  SqliteBankStatementParseRepository,
  SqliteUserRepository,
  SqliteUserProfileRepository,
  SqliteOAuthTokenRepository,
  SqlitePersonalMemoryNoteRepository,
  SqlitePersonalMemoryPinRepository,
  SqliteTransactionRunner,
  StructuredLogger,
  EnvRefreshTokenProvider,
  DbGoogleTokenProvider,
  TTLCache,
  GCalHttpClient,
  GoogleCalendarAdapter,
  GCAL_REQUIRED_SCOPES,
  GitHubHttpClient,
  GitHubAdapter,
  TeamsInboundAdapter,
  InAppNotificationAdapter,
  WebPushNotificationAdapter,
  TokenCipher,
  StaticBankStatementParserRegistry,
  ChaseBankStatementParser,
} from "@oneon/infrastructure";

import type { Env } from "./config/env.js";
import { recordGmailRefreshFailure } from "./gmail-refresh-state.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { BackgroundLoop } from "./background-loop.js";
import { createActionsFor, type ActionsModule } from "./actions-wiring.js";
import { activeMembershipLookup } from "./context-wiring.js";
import { createSnapshotRefresher, type SnapshotRefresher } from "./middleware/active-context.js";
import { createTenantDelegation } from "./tenant-delegation.js";
import { createModelWiring } from "./model-wiring.js";
import type { AiDataChoiceRepository, ModelAuditRepository, ModelGateway, ModelRouting, ProviderId, ProviderOverride } from "@oneon/application";

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
  notificationRepo: NotificationRepository;
  preferenceRepo: PreferenceRepository;
  pushSubscriptionRepo: PushSubscriptionRepository;
  bankStatementRepo: BankStatementRepository;
  bankStatementParseRepo: BankStatementParseRepository;
  bankStatementParserRegistry: BankStatementParserRegistry;
  userRepo: UserRepository | null;
  identityRepo: IdentityRepository;
  /** Link intents (spec §4.5), bound to a secret the browser keeps. */
  linkIntents: LinkIntentRepository;
  platformOperators: PlatformOperatorRepository;
  tenantRegistrations: TenantRegistrationRepository;
  enrolment: EnrolmentService;
  memberships: MembershipRepository;
  /** Each pharmacy's AI data limit (spec 9.4); the model gateway reads it on every call. */
  tenantAiLimits: TenantAiLimitRepository;
  handoffJti: UsedHandoffJti;
  /** The sole holder of delegation grants; null until ONEON_GRANT_MASTER_KEY is set. */
  impressorx: ImpressoRxClient | null;
  /** Keeps memberships' snapshots fresh and checks an approver live. One per process, so a membership's refresh is single-flight across its users. */
  snapshots: SnapshotRefresher;
  /** The personal database handle (the same one the personal repositories were built from). */
  openPersonal: () => import("@oneon/domain").PersonalDb;
  /** Opens a tenant's database through the gate (refuses when the registration is not active). */
  openTenant: (registrationId: string) => import("@oneon/domain").TenantDb;
  /** Opens a tenant's database and holds it until `release()` (a request's handle: the LRU never closes it meanwhile). */
  leaseTenant: (registrationId: string) => import("@oneon/infrastructure").TenantLease;
  /** Creates a new tenant's database file (enrolment only). */
  createTenantFile: (registrationId: string, tenantId: string) => void;
  /** What the nightly backup reads: the gate that hands out every context file's handle, and the control database. */
  backupSources: { gate: ContextDbGate; control: ControlDb };
  ensureIdentity: (user: { id: string; email: string }) => void;
  /** Makes sure an identity has its row in the personal database (linking a Google login to an existing identity needs it). */
  ensurePersonalUser: (user: { id: string; email: string }) => void;
  userProfileRepo: UserProfileRepository;
  oauthTokenRepo: OAuthTokenRepository | null;
  personalMemoryNoteRepo: PersonalMemoryNoteRepository;
  personalMemoryPinRepo: PersonalMemoryPinRepository;

  // ── External Ports ────────────────────────────────────────
  modelGateway: ModelGateway | null;
  /** The gateway for a request's handle: its model calls are audited in that handle's file. Tenant requests must use this, never `modelGateway`. */
  modelGatewayFor: (db: import("@oneon/domain").ContextDb) => ModelGateway | null;
  /** Gives the model gateway the registered tools' names and descriptions, so Oneon's own words are not mistaken for restored values. */
  setModelToolVocabulary: (tools: Array<{ name: string; description: string }>) => void;
  modelRouting: ModelRouting | null;
  aiDataChoices: AiDataChoiceRepository;
  modelAudit: ModelAuditRepository;
  modelOverrides: Map<ProviderId, ProviderOverride>;
  modelProviders: ProviderId[];
  /** Routed providers with no API key, for Settings → AI data and /api/status. */
  modelRoutingWarnings: Array<{ role: "standard" | "reasoning" | "shadow"; provider: ProviderId }>;
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

  // ── Actions (spec: Action Spec framework) ─────────────────
  actions: ActionsModule;
  /** The actions module for a request's handle (memoized per handle). Tenant requests must use this, never `actions`. */
  actionsFor: (db: import("@oneon/domain").ContextDb) => ActionsModule;
  notificationWriter: NotificationWriter;

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
  mkdirSync(dirname(env.CONTROL_DATABASE_PATH), { recursive: true });
  const control = openControlDb(env.CONTROL_DATABASE_PATH);
  const gate = new ContextDbGate({
    control,
    personalPath: env.DATABASE_PATH,
    tenantDir: env.TENANT_DATA_DIR,
  });
  const personal = gate.openPersonal();
  const db = rawDb(personal);
  const backfilled = backfillIdentities(personal, control);
  if (backfilled > 0) logger.info("Identities backfilled", { count: backfilled });
  // A merge re-owns rows in the pharmacy files, so the repository opens them through the gate.
  const identityRepo = new SqliteIdentityRepository(control, (registrationId) => gate.openTenant(registrationId));
  const linkIntents = new LinkIntentRepository(control);
  const platformOperators = new PlatformOperatorRepository(control);
  const tenantRegistrations = new TenantRegistrationRepository(control);
  const enrolment = new EnrolmentService({
    repo: tenantRegistrations,
    oneonOrigin: env.PUBLIC_URL,
    masterKeyB64: env.ONEON_SIGNING_KEY_MASTER_KEY,
  });
  const memberships = new MembershipRepository(control);
  const handoffJti = new UsedHandoffJti(control);
  const impressorx = env.ONEON_GRANT_MASTER_KEY
    ? createImpressoRxClient({
        control,
        grantMasterKeyB64: env.ONEON_GRANT_MASTER_KEY,
        enrolment,
        onSnapshot: (membershipId, snapshot) => memberships.applySnapshot(membershipId, snapshot),
        logger,
      })
    : null;
  if (!impressorx) logger.warn("ImpressoRx hand-off: disabled (missing ONEON_GRANT_MASTER_KEY)");
  const snapshots = createSnapshotRefresher({
    memberships,
    registrations: tenantRegistrations,
    client: impressorx,
    logger: new StructuredLogger("active-context", env.LOG_LEVEL),
  });
  logger.info("Database ready", { path: env.DATABASE_PATH });

  const tenantAiLimits = new TenantAiLimitRepository(control);
  const modelWiring = createModelWiring(env, { context: personal, logger, registrations: tenantRegistrations, tenantLimits: tenantAiLimits });

  // ── Repositories ──────────────────────────────────────────
  const inboundItemRepo = new SqliteInboundItemRepository(db);
  const classificationRepo = new SqliteClassificationRepository(db);
  const classificationFeedbackRepo =
    new SqliteClassificationFeedbackRepository(db);
  const deadlineRepo = new SqliteDeadlineRepository(db);
  const notificationRepo = new SqliteNotificationRepository(db);
  const preferenceRepo = new SqlitePreferenceRepository(db);
  const pushSubscriptionRepo = new SqlitePushSubscriptionRepository(db);
  const bankStatementRepo = new SqliteBankStatementRepository(db);
  const bankStatementParseRepo = new SqliteBankStatementParseRepository(db);
  const bankStatementParserRegistry = new StaticBankStatementParserRegistry([
    {
      senderDomains: ["chase.com"],
      sources: ["gmail"],
      parser: new ChaseBankStatementParser(),
    },
  ]);
  const userProfileRepo = new SqliteUserProfileRepository(db);
  const personalMemoryNoteRepo = new SqlitePersonalMemoryNoteRepository(db);
  const personalMemoryPinRepo = new SqlitePersonalMemoryPinRepository(db);

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
        () => recordGmailRefreshFailure(preferenceRepo, primaryUser!.id),
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
      () => recordGmailRefreshFailure(preferenceRepo, userId),
    );
  };

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

  const teamsPort: TeamsPort = new TeamsInboundAdapter({
    inboundItemRepo,
  });
  logger.info("Teams: ✓ local search active (inbound_items-backed)");

  const inAppNotifications = new InAppNotificationAdapter({ notificationRepo, preferenceRepo, logger });
  const inAppNotificationPort: NotificationPort = inAppNotifications;
  let webPushNotifications: WebPushNotificationAdapter | null = null;

  let notificationPort: NotificationPort = inAppNotificationPort;

  if (env.FEATURE_PUSH_NOTIFICATIONS) {
    if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT) {
      const webPush = new WebPushNotificationAdapter({
        pushSubscriptionRepo,
        preferenceRepo,
        vapidPublicKey: env.VAPID_PUBLIC_KEY,
        vapidPrivateKey: env.VAPID_PRIVATE_KEY,
        vapidSubject: env.VAPID_SUBJECT,
        logger,
      });
      webPushNotifications = webPush;

      notificationPort = {
        async send(notification): Promise<void> {
          await inAppNotificationPort.send(notification);
          await webPush.send(notification);
        },
      };

      logger.info("Notifications: ✓ in-app + web-push mode");
    } else {
      logger.warn(
        "Notifications: FEATURE_PUSH_NOTIFICATIONS enabled but VAPID config missing; falling back to in-app mode",
      );
      logger.info("Notifications: ✓ in-app mode");
    }
  } else {
    logger.info("Notifications: ✓ in-app mode");
  }

  // The notify executor needs to know what happened; web push stays best effort.
  const notificationWriter: NotificationWriter = {
    async deliver(notification) {
      const result = await inAppNotifications.deliver(notification);
      if (result.status === "delivered" && webPushNotifications) {
        await webPushNotifications.send(notification).catch((error: unknown) =>
          logger.warn("Web push delivery failed", { error: error instanceof Error ? error.message : String(error) }),
        );
      }
      return result;
    },
  };

  const activeMemberships = activeMembershipLookup(tenantRegistrations, memberships);
  const actionsFor = createActionsFor({
    memberships: activeMemberships,
    delegation: createTenantDelegation({
      client: impressorx,
      memberships: activeMemberships,
      snapshots,
      logger: new StructuredLogger("tenant-delegation", env.LOG_LEVEL),
    }),
    publicUrl: env.PUBLIC_URL,
    calendarId: env.CALENDAR_ID,
    calendarCacheTtlMs: env.CALENDAR_CACHE_TTL_MS,
    oauthTokenRepo,
    deadlines: deadlineRepo,
    notificationRepo,
    preferenceRepo,
    notificationPort,
    notificationWriter,
    createGoogleTokenProvider,
    logger,
  });
  const actions = actionsFor(personal);

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
    control.close();
    logger.info("Database connection closed");
  }

  return {
    env,
    db,
    inboundItemRepo,
    classificationRepo,
    classificationFeedbackRepo,
    deadlineRepo,
    notificationRepo,
    preferenceRepo,
    pushSubscriptionRepo,
    bankStatementRepo,
    bankStatementParseRepo,
    bankStatementParserRegistry,
    userRepo,
    identityRepo,
    linkIntents,
    platformOperators,
    tenantRegistrations,
    enrolment,
    memberships,
    tenantAiLimits,
    handoffJti,
    impressorx,
    snapshots,
    openPersonal: () => personal,
    openTenant: (registrationId) => gate.openTenant(registrationId),
    leaseTenant: (registrationId) => gate.lease(registrationId),
    createTenantFile: (registrationId, tenantId) => void gate.createTenantFile(registrationId, tenantId),
    backupSources: { gate, control },
    ensureIdentity: (user) => void ensureIdentityForUser(control, user),
    ensurePersonalUser: (user) => {
      // Without the OAuth key there is no user repository: the anchor row (the same one tenant files use) is what the foreign keys need.
      if (userRepo) userRepo.upsert(user);
      else ensureIdentityAnchor(personal, user.id);
    },
    userProfileRepo,
    oauthTokenRepo,
    personalMemoryNoteRepo,
    personalMemoryPinRepo,
    hasGoogleCredentials: hasGoogleClientCreds,
    getEligibleUsers,
    createGoogleTokenProvider,
    modelGateway: modelWiring.gateway,
    modelGatewayFor: modelWiring.gatewayFor,
    setModelToolVocabulary: modelWiring.setToolVocabulary,
    modelRouting: modelWiring.routing,
    aiDataChoices: modelWiring.choices,
    modelAudit: modelWiring.audit,
    modelOverrides: modelWiring.overrides,
    modelProviders: modelWiring.configuredProviders,
    modelRoutingWarnings: modelWiring.routingWarnings,
    calendarPort,
    githubPort,
    teamsPort,
    notificationPort,
    transactionRunner,
    actions,
    actionsFor,
    notificationWriter,
    backgroundLoop: null,
    logger,
    shutdown,
  };
}
