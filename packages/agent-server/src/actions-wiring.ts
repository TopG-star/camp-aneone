import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  evaluateNotificationSuppression,
  type ActionCapabilities,
  type ActionConfigRepository,
  type ActionInstanceRepository,
  type CalendarReader,
  type ContextDb,
  type CalendarWriter,
  type Deadline,
  type LegacyActionRepository,
  type MembershipLike,
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
  type AnyActionDefinition,
  type TenantDelegation,
} from "@oneon/application";
import {
  GCalHttpClient,
  forEachTenant,
  GoogleCalendarAdapter,
  TTLCache,
  runActionDriftCheck,
  type ForEachTenantDeps,
  type TokenProvider,
} from "@oneon/infrastructure";
import { contextRepos } from "./context-wiring.js";

export interface ActionsWiringDeps {
  /** The personal handle: the orchestrator and the startup tasks run on the personal context only. */
  context: ContextDb;
  /** Current active membership of an identity at a tenant (registry tenant id). Defaults to none, so a tenant action fails closed. */
  memberships?: { activeFor(identityId: string, tenantId: string): MembershipLike | null };
  /** The person's delegated access to a pharmacy's ImpressoRx. Without it a tenant action can be neither approved nor executed. */
  delegation?: TenantDelegation;
  /** Every action definition this process registers. Defaults to the production set; tests register their own tenant definitions. */
  definitions?: () => AnyActionDefinition[];
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
  /**
   * Read-only view of the same per-user adapter the executors write through, so a write
   * invalidates the cache every reader (chat, Today) sees. Null when the user has no Google token.
   */
  calendarReaderFor(userId: string): CalendarReader | null;
}

/** The only place outside infrastructure that holds a CalendarWriter (spec §5, Task 15 test). */
export function createActionsModule(deps: ActionsWiringDeps): ActionsModule {
  const isTenant = deps.context.kind === "tenant";
  // B-core has no tenant action types, so a tenant handle gets an empty registry (R1: a type exists only if registered).
  const registry = createActionRegistry((deps.definitions?.() ?? createActionDefinitions()).filter((d) => (d.scope === "tenant") === isTenant));
  const repos = contextRepos(deps.context);
  const { actionInstances: instanceRepo, actionConfigs: configRepo } = repos;
  const calendars = new Map<string, GoogleCalendarAdapter>();

  function calendarFor(userId: string): GoogleCalendarAdapter | null {
    if (isTenant) return null; // no Google access in a pharmacy context
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
    if (isTenant) {
      return {
        readers: {
          calendar: null,
          deadlines: { findById: () => null },
          notifications: { isSuppressed: () => null, findById: () => null },
          identity: { googleEmail: null },
          links: { inboundItem: (id) => `${deps.publicUrl}/items/${id}` },
        },
        writers: { calendar: null, notifications: null },
      };
    }
    const calendar = calendarFor(userId);
    const reader: CalendarReader | null = calendar;
    const writer: CalendarWriter | null = calendar;
    return {
      readers: {
        calendar: reader,
        // Bound to the requesting user: other users' rows (and null-owner rows) are invisible.
        deadlines: {
          findById: (id) => {
            const d = deps.deadlines.findById(id);
            return d && d.userId === userId ? d : null;
          },
        },
        notifications: {
          isSuppressed: (uid, eventType, now) =>
            evaluateNotificationSuppression(deps.preferenceRepo, uid, eventType, now, (m, meta) => deps.logger.warn(m, meta)),
          findById: (id) => {
            const n = deps.notificationRepo.findById(id);
            return n && n.userId === userId ? n : null;
          },
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
    memberships: deps.memberships ?? { activeFor: () => null },
    delegation: isTenant ? deps.delegation : undefined,
    capabilities: capabilitiesFor,
    // Tenant notifications are not part of B-core; the personal notifier would address a personal inbox.
    notifier: isTenant ? { awaitingApproval: async () => {}, rollbackFailed: async () => {} } : createActionNotifier(deps.notificationPort, deps.logger),
    logger: deps.logger,
    clock: () => new Date(),
    newId: randomUUID,
  });

  const module: ActionsModule = { orchestrator, registry, instanceRepo, configRepo, capabilitiesFor, calendarReaderFor: calendarFor } as ActionsModule;
  // Personal-only: reading it for a tenant handle throws (see contextRepos). Not enumerable, so inspecting a module never trips it.
  Object.defineProperty(module, "legacyRepo", { get: () => repos.legacyActions, enumerable: false });
  return module;
}

const modules = new WeakMap<ContextDb, ActionsModule>();

/** The actions module for a handle, built once per handle (like contextRepos). Never keep it beyond the handle's request. */
export function createActionsFor(base: Omit<ActionsWiringDeps, "context">): (db: ContextDb) => ActionsModule {
  return (db) => {
    let module = modules.get(db);
    if (!module) {
      module = createActionsModule({ ...base, context: db });
      modules.set(db, module);
    }
    return module;
  };
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Spec §7.4: sweep and expire for one user. Never throws, so recovery cannot fail a cycle. The deadline is cooperative: a sweep that
 * is already running is not cut short, but expiry waits for the next pass once the deadline has gone.
 */
export async function runActionRecovery(actions: ActionsModule, userId: string, logger: Logger, deadline?: number): Promise<void> {
  try {
    await actions.orchestrator.sweep(userId);
  } catch (error) {
    logger.warn("Action sweep failed", { userId, error: errorMessage(error) });
  }
  if (deadline !== undefined && Date.now() >= deadline) {
    logger.warn("Action recovery passed its time budget; expiry continues next pass", { userId });
    return;
  }
  try {
    await actions.orchestrator.expireStale(userId);
  } catch (error) {
    logger.warn("Action expiry failed", { userId, error: errorMessage(error) });
  }
}

/** Recovery for every active tenant, one leased file at a time. A tenant that cannot be opened or swept is logged and skipped. */
export async function runTenantActionRecovery(
  deps: {
    registrations: ForEachTenantDeps["registrations"];
    gate: ForEachTenantDeps["gate"];
    actionsFor(db: ContextDb): ActionsModule;
  },
  logger: Logger,
): Promise<void> {
  let result;
  try {
    // A tenant's actions are owned by the tenant id (spec §7.4), so one sweep covers all its people.
    result = await forEachTenant({ gate: deps.gate, registrations: deps.registrations, logger }, (db, deadline) =>
      runActionRecovery(deps.actionsFor(db), db.tenantId, logger, deadline),
    );
  } catch (error) {
    logger.warn("Tenant action recovery could not list registrations", { error: errorMessage(error) });
    return;
  }
  for (const registrationId of result.failed) {
    logger.warn("Tenant action recovery failed", { registrationId, error: result.errors[registrationId] });
  }
  for (const { registrationId, code } of result.refused) {
    logger.warn("Tenant action recovery failed", { registrationId, error: code });
  }
}

/** Spec §8.4, §8.6, §7.4: drift check, one-time legacy import, then recovery for every user. */
export async function runActionStartupTasks(
  container: {
    db: Database.Database;
    actions: ActionsModule;
    userRepo: { list(): Array<{ id: string }> } | null;
    tenants?: Parameters<typeof runTenantActionRecovery>[0];
  },
  logger: Logger,
): Promise<void> {
  const repaired = runActionDriftCheck(container.db, logger);
  if (repaired > 0) logger.warn("Repaired action projections at startup", { repaired });
  const userIds = container.userRepo?.list().map((u) => u.id) ?? [];
  try {
    await importLegacyProposals({
      legacyRepo: container.actions.legacyRepo,
      requestAction: container.actions.orchestrator.requestAction,
      userIds,
      logger,
    });
  } catch (error) {
    logger.warn("Legacy proposal import failed", { error: errorMessage(error) });
  }
  for (const userId of userIds) {
    await runActionRecovery(container.actions, userId, logger);
  }
  if (container.tenants) await runTenantActionRecovery(container.tenants, logger);
}
