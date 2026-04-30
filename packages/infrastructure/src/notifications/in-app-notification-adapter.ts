import type {
  NotificationPort,
  NotificationRepository,
  PreferenceRepository,
  Logger,
} from "@oneon/domain";
import { getUserScopedPreference } from "@oneon/domain";

export interface InAppNotificationAdapterConfig {
  notificationRepo: NotificationRepository;
  preferenceRepo: PreferenceRepository;
  logger: Logger;
}

/**
 * In-app notification adapter (FR-047, FR-050).
 *
 * Writes notifications to the `notifications` table via NotificationRepository.
 * Before writing, checks:
 *   1. Per-event-type toggle: preference key `notification.enabled.<eventType>` (default "true")
 *   2. Quiet hours: preference key `notification.quiet_hours` — JSON `{ start: "HH:mm", end: "HH:mm" }`
 *
 * Provider-agnostic — implements NotificationPort so it can be swapped for WebPush later.
 */
export class InAppNotificationAdapter implements NotificationPort {
  private readonly notificationRepo: NotificationRepository;
  private readonly preferenceRepo: PreferenceRepository;
  private readonly logger: Logger;

  constructor(config: InAppNotificationAdapterConfig) {
    this.notificationRepo = config.notificationRepo;
    this.preferenceRepo = config.preferenceRepo;
    this.logger = config.logger;
  }

  async send(notification: {
    eventType: string;
    title: string;
    body: string;
    deepLink?: string;
    userId?: string | null;
  }): Promise<void> {
    const userId = notification.userId ?? null;

    // ── 1. Check per-event-type toggle ────────────────────
    const enabledKey = `notification.enabled.${notification.eventType}`;
    const enabledValue = userId
      ? getUserScopedPreference(this.preferenceRepo, userId, enabledKey)
      : this.preferenceRepo.get(enabledKey);
    // Default is enabled; only disabled if explicitly set to "false"
    if (enabledValue === "false") {
      this.logger.debug("Notification suppressed: event type disabled", {
        eventType: notification.eventType,
      });
      return;
    }

    // ── 2. Check quiet hours ──────────────────────────────
    if (this.isQuietHours(userId)) {
      this.logger.debug("Notification suppressed: quiet hours active", {
        eventType: notification.eventType,
      });
      return;
    }

    // ── 3. Persist notification ───────────────────────────
    const created = this.notificationRepo.create({
      eventType: notification.eventType,
      title: notification.title,
      body: notification.body,
      deepLink: notification.deepLink ?? null,
      read: false,
      userId,
    });

    this.logger.info("Notification created", {
      id: created.id,
      eventType: notification.eventType,
    });
  }

  /**
   * Checks if the current time falls within the configured quiet hours.
   *
   * Timezone resolution order:
   *   1. User preference `notification.timezone` (e.g. "America/New_York")
   *   2. Server-local timezone (fallback for MVP single-user)
   *
   * Quiet hours JSON: `{ start: "HH:mm", end: "HH:mm" }`
   * Supports both same-day (09:00–17:00) and overnight (22:00–07:00) ranges.
   */
  private isQuietHours(userId: string | null): boolean {
    const quietHoursJson = userId
      ? getUserScopedPreference(this.preferenceRepo, userId, "notification.quiet_hours")
      : this.preferenceRepo.get("notification.quiet_hours");
    if (!quietHoursJson) return false;

    try {
      const { start, end } = JSON.parse(quietHoursJson) as {
        start?: string;
        end?: string;
      };
      if (!start || !end) return false;

      // Resolve timezone: user preference → server-local
      const tz = userId
        ? getUserScopedPreference(this.preferenceRepo, userId, "notification.timezone")
        : this.preferenceRepo.get("notification.timezone");
      const now = new Date();
      let currentMinutes: number;

      if (tz) {
        try {
          // Use Intl to get hours/minutes in the user's timezone
          const parts = new Intl.DateTimeFormat("en-US", {
            timeZone: tz,
            hour: "numeric",
            minute: "numeric",
            hour12: false,
          }).formatToParts(now);

          const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
          const minute = Number(
            parts.find((p) => p.type === "minute")?.value ?? 0,
          );
          currentMinutes = hour * 60 + minute;
        } catch {
          this.logger.warn("Invalid notification.timezone, falling back to server time", {
            timezone: tz,
          });
          currentMinutes = now.getHours() * 60 + now.getMinutes();
        }
      } else {
        // Fallback: server-local time
        currentMinutes = now.getHours() * 60 + now.getMinutes();
      }

      const [startH, startM] = start.split(":").map(Number);
      const [endH, endM] = end.split(":").map(Number);
      const startMinutes = startH * 60 + startM;
      const endMinutes = endH * 60 + endM;

      if (startMinutes <= endMinutes) {
        // Same-day range (e.g., 09:00–17:00)
        return currentMinutes >= startMinutes && currentMinutes < endMinutes;
      }
      // Overnight range (e.g., 22:00–07:00)
      return currentMinutes >= startMinutes || currentMinutes < endMinutes;
    } catch {
      this.logger.warn("Invalid quiet hours preference, ignoring", {
        raw: quietHoursJson,
      });
      return false;
    }
  }
}
