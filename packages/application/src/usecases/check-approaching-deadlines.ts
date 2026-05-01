import type {
  DeadlineRepository,
  NotificationPort,
  NotificationRepository,
  Logger,
} from "@oneon/domain";
import { NotificationEventType } from "@oneon/domain";
import { evaluateReminderPriorityPolicy } from "./reminder-priority-policy.js";

export interface CheckApproachingDeadlinesDeps {
  deadlineRepo: DeadlineRepository;
  notificationPort: NotificationPort;
  notificationRepo: NotificationRepository;
  logger: Logger;
  userId: string;
}

export interface CheckApproachingDeadlinesOptions {
  leadDays: number;
}

export interface CheckApproachingDeadlinesResult {
  checked: number;
  notified: number;
  skippedAlreadyNotified: number;
}

/**
 * Scans open deadlines within the lead-time window and sends
 * `deadline_approaching` notifications for each one — unless a notification
 * with the same deep-link already exists (deduplication).
 *
 * Called as part of the background processing cycle.
 */
export async function checkApproachingDeadlines(
  deps: CheckApproachingDeadlinesDeps,
  options: CheckApproachingDeadlinesOptions,
): Promise<CheckApproachingDeadlinesResult> {
  const { deadlineRepo, notificationPort, notificationRepo, logger } = deps;

  const now = new Date();
  const future = new Date(now.getTime() + options.leadDays * 24 * 60 * 60 * 1000);

  const deadlines = deadlineRepo.findByDateRange(
    now.toISOString(),
    future.toISOString(),
    "open",
    deps.userId,
  );

  const result: CheckApproachingDeadlinesResult = {
    checked: deadlines.length,
    notified: 0,
    skippedAlreadyNotified: 0,
  };

  // Dedupe window: only suppress if a notification for the same deepLink
  // was created within the current lead-time window. This allows
  // re-notification across separate cycles (e.g., 7-day vs. 1-day reminder).
  const dedupeWindowMs = options.leadDays * 24 * 60 * 60 * 1000;
  const dedupeThreshold = new Date(now.getTime() - dedupeWindowMs).toISOString();

  for (const deadline of deadlines) {
    const deepLink = `/deadlines/${deadline.id}`;

    const policyDecision = evaluateReminderPriorityPolicy({
      userId: deps.userId,
      eventType: NotificationEventType.DeadlineApproaching,
      confidence: deadline.confidence,
    });

    if (!policyDecision.shouldNotify) {
      continue;
    }

    if (hasExistingNotification(notificationRepo, deepLink, dedupeThreshold, deps.userId)) {
      result.skippedAlreadyNotified++;
      continue;
    }

    await notificationPort.send({
      eventType: NotificationEventType.DeadlineApproaching,
      title: `Deadline approaching: ${deadline.description}`,
      body: `Due ${formatDueDate(deadline.dueDate)}`,
      deepLink,
      userId: deps.userId,
    });

    result.notified++;
  }

  if (result.notified > 0) {
    logger.info("Deadline approaching notifications sent", {
      checked: result.checked,
      notified: result.notified,
      skippedAlreadyNotified: result.skippedAlreadyNotified,
    });
  }

  return result;
}

/**
 * Check if a notification with this deepLink already exists
 * within the dedupe window. Scans recent notifications (last 100).
 */
function hasExistingNotification(
  notificationRepo: NotificationRepository,
  deepLink: string,
  dedupeThreshold: string,
  userId: string,
): boolean {
  const recent = notificationRepo.findAll({ limit: 100, userId });
  return recent.some(
    (n) => n.deepLink === deepLink && n.createdAt >= dedupeThreshold,
  );
}

function formatDueDate(isoDate: string): string {
  const d = new Date(isoDate);
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}
