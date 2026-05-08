import { Router } from "express";
import type {
  Classification,
  ClassificationRepository,
  Deadline,
  InboundItemRepository,
  InboundItem,
  PreferenceRepository,
  DeadlineRepository,
  ActionLogRepository,
  NotificationRepository,
  CalendarPort,
  Logger,
} from "@oneon/domain";

// ── Types ────────────────────────────────────────────────────

export interface TodayRouteDeps {
  classificationRepo: ClassificationRepository;
  inboundItemRepo: InboundItemRepository;
  deadlineRepo: DeadlineRepository;
  actionLogRepo: ActionLogRepository;
  notificationRepo: NotificationRepository;
  preferenceRepo: PreferenceRepository;
  calendarPort?: CalendarPort | null;
  logger: Logger;
}

type TriageKind =
  | "urgent_email"
  | "teams_incident"
  | "pr_review"
  | "deadline_pressure";

interface TriageQueueItem {
  id: string;
  kind: TriageKind;
  source: string;
  title: string;
  reason: string;
  explainability: {
    summary: string;
    signals: string[];
  };
  score: number;
  href: string;
  observedAt: string;
  lastUpdatedAt: string;
  occurredAt: string;
}

interface TriageSuppressionEntry {
  state: "snoozed" | "dismissed";
  until: string | null;
  updatedAt: string;
}

type TriageSuppressions = Record<string, TriageSuppressionEntry>;

const TRIAGE_SUPPRESSION_KEY_PREFIX = "triage.suppressions";
const TRIAGE_MIN_SCORE = 50;
const TRIAGE_MAX_ITEMS = 20;
const TRIAGE_KIND_CAP: Record<TriageKind, number> = {
  urgent_email: 6,
  teams_incident: 6,
  pr_review: 6,
  deadline_pressure: 6,
};

// ── Router ───────────────────────────────────────────────────

export function createTodayRouter(deps: TodayRouteDeps): Router {
  const router = Router();
  const {
    classificationRepo,
    inboundItemRepo,
    deadlineRepo,
    actionLogRepo,
    notificationRepo,
    preferenceRepo,
    calendarPort,
    logger,
  } = deps;

  router.post("/triage/:itemId/snooze", (req, res) => {
    try {
      const userId = req.userId!;
      const itemId = String(req.params.itemId ?? "").trim();
      if (!itemId) {
        res.status(400).json({ error: "itemId is required" });
        return;
      }

      const rawHours = req.body && typeof req.body === "object" ? (req.body as { hours?: unknown }).hours : undefined;
      const parsedHours =
        typeof rawHours === "number" && Number.isFinite(rawHours)
          ? Math.round(rawHours)
          : typeof rawHours === "string"
            ? parseInt(rawHours, 10)
            : NaN;
      const snoozeHours = Number.isFinite(parsedHours) ? Math.min(Math.max(parsedHours, 1), 24 * 14) : 24;

      const now = new Date();
      const until = new Date(now.getTime() + snoozeHours * 60 * 60 * 1000).toISOString();
      const key = suppressionPreferenceKey(userId);
      const suppressions = loadTriageSuppressions(preferenceRepo, key);
      suppressions[itemId] = {
        state: "snoozed",
        until,
        updatedAt: now.toISOString(),
      };
      saveTriageSuppressions(preferenceRepo, key, suppressions);

      res.status(200).json({ success: true, itemId, state: "snoozed", until });
    } catch (error) {
      logger.error("Failed to snooze triage item", {
        error: error instanceof Error ? error.message : String(error),
        itemId: req.params.itemId,
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/triage/:itemId/dismiss", (req, res) => {
    try {
      const userId = req.userId!;
      const itemId = String(req.params.itemId ?? "").trim();
      if (!itemId) {
        res.status(400).json({ error: "itemId is required" });
        return;
      }

      const key = suppressionPreferenceKey(userId);
      const suppressions = loadTriageSuppressions(preferenceRepo, key);
      suppressions[itemId] = {
        state: "dismissed",
        until: null,
        updatedAt: new Date().toISOString(),
      };
      saveTriageSuppressions(preferenceRepo, key, suppressions);

      res.status(200).json({ success: true, itemId, state: "dismissed" });
    } catch (error) {
      logger.error("Failed to dismiss triage item", {
        error: error instanceof Error ? error.message : String(error),
        itemId: req.params.itemId,
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── GET / — Aggregated "today" dashboard data ─────────────
  router.get("/", async (req, res) => {
    try {
      const userId = req.userId!;
      const now = new Date();
      const nowIso = now.toISOString();
      const dateStr = now.toISOString().slice(0, 10);

      // Start of today (UTC) and 7 days ahead for deadlines
      const todayStart = `${dateStr}T00:00:00.000Z`;
      const triageLookbackStart = new Date(now.getTime() - 72 * 60 * 60 * 1000).toISOString();
      const weekAhead = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      const weekAheadStr = weekAhead.toISOString();
      const suppressionKey = suppressionPreferenceKey(userId);
      const rawSuppressions = loadTriageSuppressions(preferenceRepo, suppressionKey);
      const { suppressions, changed } = pruneExpiredSuppressions(rawSuppressions, now);
      if (changed) {
        saveTriageSuppressions(preferenceRepo, suppressionKey, suppressions);
      }

      // Calendar events (today only)
      let calendarStatus: "connected" | "unavailable" = "unavailable";
      let calendarEvents: unknown[] = [];
      if (calendarPort) {
        try {
          const endOfDay = `${dateStr}T23:59:59.999Z`;
          calendarEvents = await calendarPort.listEvents(todayStart, endOfDay);
          calendarStatus = "connected";
        } catch (err) {
          logger.warn("Calendar unavailable for today view", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Urgent items: priority ≤ 2 from recent classifications
      const recentItems = inboundItemRepo.findAll({ limit: 200, since: todayStart, userId });
      const triageCandidates = inboundItemRepo.findAll({
        limit: 400,
        since: triageLookbackStart,
        userId,
      });
      const classificationByItemId = new Map<string, Classification | null>();
      const getClassification = (itemId: string): Classification | null => {
        if (classificationByItemId.has(itemId)) {
          return classificationByItemId.get(itemId) ?? null;
        }

        const classification = classificationRepo.findByInboundItemId(itemId);
        classificationByItemId.set(itemId, classification);
        return classification;
      };

      const urgentItems: Array<{
        id: string;
        subject: string;
        source: string;
        priority: number;
        category: string;
      }> = [];
      for (const item of recentItems) {
        const classification = getClassification(item.id);
        if (classification && classification.priority <= 2) {
          urgentItems.push({
            id: item.id,
            subject: item.subject,
            source: item.source,
            priority: classification.priority,
            category: classification.category,
          });
        }
      }

      // Deadlines in next 7 days
      const deadlines = deadlineRepo.findByDateRange(todayStart, weekAheadStr, "open", userId);
      const overdueDeadlines = deadlineRepo.findOverdue(userId);

      // Unified triage queue: email urgency, Teams incidents, PR review needs, and deadline pressure.
      const triageQueue: TriageQueueItem[] = [];
      for (const item of triageCandidates) {
        const classification = getClassification(item.id);

        if (isUrgentEmailCandidate(item, classification)) {
          triageQueue.push({
            id: `urgent-email:${item.id}`,
            kind: "urgent_email",
            source: item.source,
            title: item.subject,
            reason: buildUrgentEmailReason(classification),
            explainability: {
              summary: "High-priority email signal matched triage guardrails.",
              signals: compactSignals([
                `Source: ${item.source}`,
                classification ? `Priority: P${classification.priority}` : null,
                classification ? `Category: ${classification.category}` : null,
              ]),
            },
            score: scoreUrgentEmail(item, classification, now),
            href: `/inbox?id=${item.id}`,
            observedAt: nowIso,
            lastUpdatedAt: item.updatedAt,
            occurredAt: item.receivedAt,
          });
        }

        if (isTeamsIncidentCandidate(item, classification)) {
          triageQueue.push({
            id: `teams-incident:${item.id}`,
            kind: "teams_incident",
            source: item.source,
            title: item.subject,
            reason: buildTeamsIncidentReason(classification),
            explainability: {
              summary: "Teams message matched incident-response criteria.",
              signals: compactSignals([
                `Source: ${item.source}`,
                classification ? `Priority: P${classification.priority}` : null,
                hasIncidentKeywords(item) ? "Incident keywords detected" : null,
              ]),
            },
            score: scoreTeamsIncident(item, classification, now),
            href: `/inbox?id=${item.id}`,
            observedAt: nowIso,
            lastUpdatedAt: item.updatedAt,
            occurredAt: item.receivedAt,
          });
        }

        if (isPRReviewCandidate(item)) {
          triageQueue.push({
            id: `pr-review:${item.id}`,
            kind: "pr_review",
            source: item.source,
            title: item.subject,
            reason: "PR review is requested and ready for response.",
            explainability: {
              summary: "GitHub PR review signals are present and fresh enough for queue ranking.",
              signals: compactSignals([
                `Source: ${item.source}`,
                hasReviewRequestedLabel(item.labels) ? "Label: review_requested" : null,
                "Pull request context detected",
              ]),
            },
            score: scorePRReview(item, now),
            href: `/inbox?id=${item.id}`,
            observedAt: nowIso,
            lastUpdatedAt: item.updatedAt,
            occurredAt: item.receivedAt,
          });
        }
      }

      const deadlineById = new Map<string, Deadline>();
      for (const deadline of [...overdueDeadlines, ...deadlines]) {
        if (!deadlineById.has(deadline.id)) {
          deadlineById.set(deadline.id, deadline);
        }
      }

      for (const deadline of deadlineById.values()) {
        triageQueue.push({
          id: `deadline:${deadline.id}`,
          kind: "deadline_pressure",
          source: "deadlines",
          title: deadline.description,
          reason: buildDeadlineReason(deadline, now),
          explainability: {
            summary: "Deadline timing pressure exceeded ranking guardrails.",
            signals: compactSignals([
              `Due: ${formatDayLabel(deadline.dueDate)}`,
              deadline.confidence >= 0 ? `Confidence: ${Math.round(deadline.confidence * 100)}%` : null,
              new Date(deadline.dueDate).getTime() <= now.getTime() ? "Status: Overdue" : "Status: Upcoming",
            ]),
          },
          score: scoreDeadlinePressure(deadline, now),
          href: "/deadlines",
          observedAt: nowIso,
          lastUpdatedAt: deadline.updatedAt,
          occurredAt: deadline.dueDate,
        });
      }

      const rankedTriageQueue = applyTriageGuardrails(triageQueue).filter(
        (item) => !isSuppressed(item.id, suppressions, now),
      );

      // Pending actions
      const pendingActions = actionLogRepo.findByStatus("proposed", 10, userId);
      const pendingCount = actionLogRepo.count({ status: "proposed", userId });

      // Counts
      const unreadNotifications = notificationRepo.countUnread(userId);
      const totalInbox = inboundItemRepo.count({ userId });

      res.json({
        date: dateStr,
        briefingSummary: null, // LLM summary deferred — data-only for now
        calendar: {
          status: calendarStatus,
          events: calendarEvents,
        },
        urgentItems,
        deadlines,
        triageQueue: rankedTriageQueue,
        pendingActions: {
          count: pendingCount,
          items: pendingActions,
        },
        counts: {
          unreadNotifications,
          totalInbox,
          pendingActions: pendingCount,
        },
      });
    } catch (error) {
      logger.error("Failed to build today view", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

function isUrgentEmailCandidate(
  item: InboundItem,
  classification: Classification | null,
): boolean {
  if (item.source !== "gmail" && item.source !== "outlook") {
    return false;
  }
  return !!classification && classification.priority <= 2;
}

function isTeamsIncidentCandidate(
  item: InboundItem,
  classification: Classification | null,
): boolean {
  if (item.source !== "teams") {
    return false;
  }

  if (classification && classification.priority <= 2) {
    return true;
  }

  return hasIncidentKeywords(item);
}

function isPRReviewCandidate(item: InboundItem): boolean {
  if (item.source !== "github") {
    return false;
  }

  const labels = parseLabels(item.labels);
  const hasPullRequestSignal = labels.has("pull_request") || item.subject.toLowerCase().includes("pr #");
  const hasReviewSignal =
    labels.has("review_requested") ||
    item.subject.toLowerCase().includes("review") ||
    item.bodyPreview.toLowerCase().includes("review requested");

  return hasPullRequestSignal && hasReviewSignal;
}

function scoreUrgentEmail(
  item: InboundItem,
  classification: Classification | null,
  now: Date,
): number {
  const priority = classification?.priority ?? 3;
  const priorityBoost = priority === 1 ? 12 : priority === 2 ? 8 : 0;
  return 70 + priorityBoost + recencyBoost(item.receivedAt, now);
}

function scoreTeamsIncident(
  item: InboundItem,
  classification: Classification | null,
  now: Date,
): number {
  const priorityBoost = classification?.priority === 1 ? 10 : classification?.priority === 2 ? 6 : 0;
  const keywordBoost = isTeamsIncidentCandidate(item, null) ? 6 : 0;
  return 74 + priorityBoost + keywordBoost + recencyBoost(item.receivedAt, now);
}

function scorePRReview(item: InboundItem, now: Date): number {
  const reviewBoost = hasReviewRequestedLabel(item.labels) ? 10 : 5;
  return 78 + reviewBoost + recencyBoost(item.receivedAt, now);
}

function scoreDeadlinePressure(deadline: Deadline, now: Date): number {
  const dueAt = new Date(deadline.dueDate).getTime();
  const hoursUntilDue = (dueAt - now.getTime()) / (60 * 60 * 1000);

  if (hoursUntilDue <= 0) {
    return 100;
  }
  if (hoursUntilDue <= 12) {
    return 94;
  }
  if (hoursUntilDue <= 24) {
    return 90;
  }
  if (hoursUntilDue <= 72) {
    return 84;
  }
  return 76;
}

function recencyBoost(receivedAtIso: string, now: Date): number {
  const ageHours = (now.getTime() - new Date(receivedAtIso).getTime()) / (60 * 60 * 1000);
  if (ageHours <= 6) {
    return 8;
  }
  if (ageHours <= 24) {
    return 4;
  }
  return 0;
}

function buildUrgentEmailReason(classification: Classification | null): string {
  if (!classification) {
    return "Urgent email signal detected from recent inbox activity.";
  }

  return `Priority P${classification.priority} email requiring prompt attention.`;
}

function buildTeamsIncidentReason(classification: Classification | null): string {
  if (classification && classification.priority <= 2) {
    return `Teams incident signal with priority P${classification.priority}.`;
  }

  return "Teams message matched incident/outage keywords requiring triage.";
}

function buildDeadlineReason(deadline: Deadline, now: Date): string {
  const due = new Date(deadline.dueDate);
  if (due.getTime() <= now.getTime()) {
    return `Overdue since ${formatDayLabel(deadline.dueDate)}.`;
  }
  return `Due ${formatDayLabel(deadline.dueDate)}.`;
}

function formatDayLabel(isoDate: string): string {
  return new Date(isoDate).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function parseLabels(rawLabels: string): Set<string> {
  try {
    const parsed = JSON.parse(rawLabels);
    if (!Array.isArray(parsed)) {
      return new Set<string>();
    }

    return new Set(
      parsed
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.toLowerCase()),
    );
  } catch {
    return new Set<string>();
  }
}

function hasReviewRequestedLabel(rawLabels: string): boolean {
  return parseLabels(rawLabels).has("review_requested");
}

function hasIncidentKeywords(item: InboundItem): boolean {
  const text = `${item.subject} ${item.bodyPreview}`.toLowerCase();
  const incidentKeywords = [
    "incident",
    "outage",
    "sev0",
    "sev1",
    "p0",
    "p1",
    "critical",
    "production down",
    "degraded",
    "customer impact",
  ];

  return incidentKeywords.some((keyword) => text.includes(keyword));
}

function compactSignals(values: Array<string | null>): string[] {
  return values.filter((value): value is string => !!value && value.trim().length > 0);
}

function suppressionPreferenceKey(userId: string): string {
  return `${TRIAGE_SUPPRESSION_KEY_PREFIX}.${userId}`;
}

function loadTriageSuppressions(
  preferenceRepo: PreferenceRepository,
  key: string,
): TriageSuppressions {
  const raw = preferenceRepo.get(key);
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const result: TriageSuppressions = {};
    for (const [itemId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        continue;
      }

      const candidate = value as Record<string, unknown>;
      const state = candidate.state;
      const until = candidate.until;
      const updatedAt = candidate.updatedAt;
      if (state !== "snoozed" && state !== "dismissed") {
        continue;
      }
      if (until !== null && typeof until !== "string") {
        continue;
      }
      if (typeof updatedAt !== "string") {
        continue;
      }

      result[itemId] = {
        state,
        until,
        updatedAt,
      };
    }

    return result;
  } catch {
    return {};
  }
}

function saveTriageSuppressions(
  preferenceRepo: PreferenceRepository,
  key: string,
  suppressions: TriageSuppressions,
): void {
  preferenceRepo.set(key, JSON.stringify(suppressions));
}

function pruneExpiredSuppressions(
  suppressions: TriageSuppressions,
  now: Date,
): { suppressions: TriageSuppressions; changed: boolean } {
  const next: TriageSuppressions = {};
  let changed = false;

  for (const [itemId, entry] of Object.entries(suppressions)) {
    if (entry.state === "dismissed") {
      next[itemId] = entry;
      continue;
    }

    if (!entry.until) {
      changed = true;
      continue;
    }

    const untilMs = new Date(entry.until).getTime();
    if (!Number.isFinite(untilMs) || untilMs <= now.getTime()) {
      changed = true;
      continue;
    }

    next[itemId] = entry;
  }

  if (!changed) {
    changed = Object.keys(next).length !== Object.keys(suppressions).length;
  }

  return { suppressions: next, changed };
}

function isSuppressed(
  itemId: string,
  suppressions: TriageSuppressions,
  now: Date,
): boolean {
  const entry = suppressions[itemId];
  if (!entry) {
    return false;
  }
  if (entry.state === "dismissed") {
    return true;
  }
  return !!entry.until && new Date(entry.until).getTime() > now.getTime();
}

function applyTriageGuardrails(items: TriageQueueItem[]): TriageQueueItem[] {
  const deduped = new Map<string, TriageQueueItem>();

  for (const item of items) {
    const normalized: TriageQueueItem = {
      ...item,
      score: Math.max(0, Math.min(100, Math.round(item.score))),
    };

    const existing = deduped.get(normalized.id);
    if (!existing) {
      deduped.set(normalized.id, normalized);
      continue;
    }

    if (
      normalized.score > existing.score ||
      (normalized.score === existing.score && normalized.lastUpdatedAt > existing.lastUpdatedAt)
    ) {
      deduped.set(normalized.id, normalized);
    }
  }

  const sorted = [...deduped.values()].sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return b.occurredAt.localeCompare(a.occurredAt);
  });

  const perKindCount: Record<TriageKind, number> = {
    urgent_email: 0,
    teams_incident: 0,
    pr_review: 0,
    deadline_pressure: 0,
  };
  const result: TriageQueueItem[] = [];

  for (const item of sorted) {
    if (item.score < TRIAGE_MIN_SCORE) {
      continue;
    }
    if (perKindCount[item.kind] >= TRIAGE_KIND_CAP[item.kind]) {
      continue;
    }

    result.push(item);
    perKindCount[item.kind] += 1;

    if (result.length >= TRIAGE_MAX_ITEMS) {
      break;
    }
  }

  return result;
}
