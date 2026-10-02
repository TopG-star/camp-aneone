import express from "express";
import type Database from "better-sqlite3";
import {
  ExternalCallError,
  type ActionConfigRepository,
  type ActionInstanceRepository,
  type CalendarEvent,
  type Deadline,
  type Logger,
  type LegacyActionRepository,
} from "@oneon/domain";
import { createActionDefinitions, createActionOrchestrator, createActionRegistry, type ActionOrchestrator } from "@oneon/application";
import {
  SqliteActionConfigRepository,
  SqliteActionInstanceRepository,
  SqliteLegacyActionRepository,
  createDatabase,
  runMigrations,
} from "@oneon/infrastructure";
import { createActionsRouter } from "../actions.route.js";
import { createActionDefinitionsRouter } from "../action-definitions.route.js";

export const logger: Logger = { info() {}, warn() {}, error() {}, debug() {} };

export interface WarnEntry {
  message: string;
  context?: Record<string, unknown>;
}

export interface ActionsTestApp {
  app: express.Express;
  db: Database.Database;
  orchestrator: ActionOrchestrator;
  instanceRepo: ActionInstanceRepository;
  configRepo: ActionConfigRepository;
  events: Map<string, CalendarEvent>;
  deadlines: Map<string, Deadline>;
  warnings: WarnEntry[];
  legacyRepo: LegacyActionRepository;
}

export function buildActionsTestApp(options: { createDelayMs?: number } = {}): ActionsTestApp {
  const warnings: WarnEntry[] = [];
  const testLogger: Logger = {
    ...logger,
    warn: (message, context) => {
      warnings.push({ message, context });
    },
  };
  const db: Database.Database = createDatabase(":memory:");
  runMigrations(db);
  db.prepare("INSERT INTO users (id, email) VALUES ('user-A','a@test.com'), ('user-B','b@test.com')").run();

  const events = new Map<string, CalendarEvent>();
  let version = 1;
  const deadlines = new Map<string, Deadline>();
  const calendar = {
    listEvents: async () => [...events.values()],
    searchEvents: async () => [...events.values()],
    getEvent: async (id: string) => events.get(id) ?? null,
    async create(e: Omit<CalendarEvent, "id">, o: { eventId: string }) {
      if (options.createDelayMs) await new Promise((r) => setTimeout(r, options.createDelayMs));
      const created = { ...e, id: o.eventId, etag: `"v${version++}"` } as CalendarEvent;
      events.set(created.id, created);
      return created;
    },
    async update(id: string, c: Partial<CalendarEvent>, o: { ifMatch: string }) {
      const cur = events.get(id);
      if (!cur) throw new ExternalCallError("definite", "not_found", "missing");
      if (cur.etag !== o.ifMatch) throw new ExternalCallError("definite", "changed_since", "412");
      const next = { ...cur, ...c, etag: `"v${version++}"` };
      events.set(id, next);
      return next;
    },
    async remove(id: string, o: { ifMatch: string }) {
      const cur = events.get(id);
      if (!cur) throw new ExternalCallError("definite", "not_found", "missing");
      if (cur.etag !== o.ifMatch) throw new ExternalCallError("definite", "changed_since", "412");
      events.delete(id);
    },
  };

  const registry = createActionRegistry(createActionDefinitions());
  const instanceRepo = new SqliteActionInstanceRepository(db);
  const configRepo = new SqliteActionConfigRepository(db);
  const legacyRepo = new SqliteLegacyActionRepository(db);
  const orchestrator = createActionOrchestrator({
    registry,
    repo: instanceRepo,
    configRepo,
    capabilities: () => ({
      readers: {
        calendar,
        deadlines: { findById: (id) => deadlines.get(id) ?? null },
        notifications: { isSuppressed: () => null, findById: () => null },
        identity: { googleEmail: "a@test.com" },
        links: { inboundItem: (id) => `https://oneon.test/items/${id}` },
      },
      writers: { calendar, notifications: null },
    }),
    notifier: { awaitingApproval: async () => {}, rollbackFailed: async () => {} },
    logger,
    clock: () => new Date("2026-10-01T12:00:00.000Z"),
    newId: () => crypto.randomUUID(),
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = (req.headers["x-test-user"] as string) ?? "user-A";
    next();
  });
  app.use("/api/actions", createActionsRouter({ orchestrator, registry, instanceRepo, configRepo, legacyRepo, logger: testLogger }));
  app.use("/api/action-definitions", createActionDefinitionsRouter({ registry, configRepo, logger: testLogger }));

  return { app, db, orchestrator, instanceRepo, configRepo, events, deadlines, warnings, legacyRepo };
}
