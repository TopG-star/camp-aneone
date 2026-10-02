import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  evaluateNotificationSuppression,
  type ActionCapabilities,
  type ActionConfigRepository,
  type ActionInstanceRepository,
  type CalendarReader,
  type CalendarWriter,
  type Deadline,
  type LegacyActionRepository,
  type Logger,
  type NotificationPort,
  type NotificationRepository,
  type NotificationWriter,
  type OAuthTokenRepository,
  type PreferenceRepository,
} from "@oneon/domain";
import {
  createActionDefinitions,
  createActionNotifier,
  createActionOrchestrator,
  createActionRegistry,
  importLegacyProposals,
  type ActionOrchestrator,
  type ActionRegistry,
} from "@oneon/application";
import {
  GCalHttpClient,
  GoogleCalendarAdapter,
  SqliteActionConfigRepository,
  SqliteActionInstanceRepository,
  SqliteLegacyActionRepository,
  TTLCache,
  runActionDriftCheck,
  type TokenProvider,
} from "@oneon/infrastructure";

export interface ActionsWiringDeps {
  db: Database.Database;
  publicUrl: string;
  calendarId: string;
  calendarCacheTtlMs: number;
  oauthTokenRepo: OAuthTokenRepository | null;
  deadlines: { findById(id: string): Deadline | null };
  notificationRepo: NotificationRepository;
  preferenceRepo: PreferenceRepository;
  notificationPort: NotificationPort;
  notificationWriter: NotificationWriter;
  createGoogleTokenProvider(userId: string): TokenProvider | null;
  logger: Logger;
}

export interface ActionsModule {
  orchestrator: ActionOrchestrator;
  registry: ActionRegistry;
  instanceRepo: ActionInstanceRepository;
  configRepo: ActionConfigRepository;
  legacyRepo: LegacyActionRepository;
  capabilitiesFor(userId: string): ActionCapabilities;
}

/** The only place outside infrastructure that holds a CalendarWriter (spec §5, Task 15 test). */
export function createActionsModule(deps: ActionsWiringDeps): ActionsModule {
  const registry = createActionRegistry(createActionDefinitions());
  const instanceRepo = new SqliteActionInstanceRepository(deps.db);
  const configRepo = new SqliteActionConfigRepository(deps.db);
  const legacyRepo = new SqliteLegacyActionRepository(deps.db);
  const calendars = new Map<string, GoogleCalendarAdapter>();

  function calendarFor(userId: string): GoogleCalendarAdapter | null {
    const cached = calendars.get(userId);
    if (cached) return cached;
    const tokenProvider = deps.createGoogleTokenProvider(userId);
    if (!tokenProvider) return null;
    const adapter = new GoogleCalendarAdapter({
      client: new GCalHttpClient(tokenProvider),
      calendarId: deps.calendarId,
      cache: new TTLCache(),
      cacheTtlMs: deps.calendarCacheTtlMs,
    });
    calendars.set(userId, adapter);
    return adapter;
  }

  function capabilitiesFor(userId: string): ActionCapabilities {
    const calendar = calendarFor(userId);
    const reader: CalendarReader | null = calendar;
    const writer: CalendarWriter | null = calendar;
    return {
      readers: {
        calendar: reader,
        deadlines: deps.deadlines,
        notifications: {
          isSuppressed: (uid, eventType, now) =>
            evaluateNotificationSuppression(deps.preferenceRepo, uid, eventType, now, (m, meta) => deps.logger.warn(m, meta)),
          findById: (id) => deps.notificationRepo.findById(id),
        },
        identity: { googleEmail: deps.oauthTokenRepo?.get("google", userId)?.providerEmail ?? null },
        links: { inboundItem: (id) => `${deps.publicUrl}/items/${id}` },
      },
      writers: { calendar: writer, notifications: deps.notificationWriter },
    };
  }

  const orchestrator = createActionOrchestrator({
    registry,
    repo: instanceRepo,
    configRepo,
    capabilities: capabilitiesFor,
    notifier: createActionNotifier(deps.notificationPort, deps.logger),
    logger: deps.logger,
    clock: () => new Date(),
    newId: randomUUID,
  });

  return { orchestrator, registry, instanceRepo, configRepo, legacyRepo, capabilitiesFor };
}

/** Spec §8.4, §8.6, §7.4: drift check, one-time legacy import, then recovery for every user. */
export async function runActionStartupTasks(
  container: { db: Database.Database; actions: ActionsModule; userRepo: { list(): Array<{ id: string }> } | null },
  logger: Logger,
): Promise<void> {
  const repaired = runActionDriftCheck(container.db, logger);
  if (repaired > 0) logger.warn("Repaired action projections at startup", { repaired });
  const userIds = container.userRepo?.list().map((u) => u.id) ?? [];
  await importLegacyProposals({
    legacyRepo: container.actions.legacyRepo,
    requestAction: container.actions.orchestrator.requestAction,
    userIds,
    logger,
  });
  for (const userId of userIds) {
    await container.actions.orchestrator.sweep(userId);
    await container.actions.orchestrator.expireStale(userId);
  }
}
