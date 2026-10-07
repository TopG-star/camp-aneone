import type {
  NotificationPort,
  PushSubscriptionRepository,
  PreferenceRepository,
  Logger,
} from "@oneon/domain";
import { getUserScopedPreference } from "@oneon/domain";
import * as webpush from "web-push";

export interface WebPushNotificationAdapterConfig {
  pushSubscriptionRepo: PushSubscriptionRepository;
  preferenceRepo: PreferenceRepository;
  vapidPublicKey: string;
  vapidPrivateKey: string;
  vapidSubject: string;
  logger: Logger;
}

export class WebPushNotificationAdapter implements NotificationPort {
  private readonly pushSubscriptionRepo: PushSubscriptionRepository;
  private readonly preferenceRepo: PreferenceRepository;
  private readonly logger: Logger;

  constructor(config: WebPushNotificationAdapterConfig) {
    this.pushSubscriptionRepo = config.pushSubscriptionRepo;
    this.preferenceRepo = config.preferenceRepo;
    this.logger = config.logger;

    webpush.setVapidDetails(
      config.vapidSubject,
      config.vapidPublicKey,
      config.vapidPrivateKey,
    );
  }

  async send(notification: {
    eventType: string;
    title: string;
    body: string;
    deepLink?: string;
    userId?: string | null;
  }): Promise<void> {
    const userId = notification.userId ?? null;

    if (!this.isPushEnabledForEvent(notification.eventType, userId)) {
      this.logger.debug("Web push suppressed: event type disabled", {
        eventType: notification.eventType,
      });
      return;
    }

    if (this.isQuietHours(userId)) {
      this.logger.debug("Web push suppressed: quiet hours active", {
        eventType: notification.eventType,
      });
      return;
    }

    const subscriptions = userId
      ? this.pushSubscriptionRepo.findByUserId(userId)
      : this.pushSubscriptionRepo.findAll();

    if (subscriptions.length === 0) {
      this.logger.debug("Web push skipped: no subscriptions", {
        eventType: notification.eventType,
      });
      return;
    }

    const payload = JSON.stringify({
      eventType: notification.eventType,
      title: notification.title,
      body: notification.body,
      deepLink: notification.deepLink ?? null,
      createdAt: new Date().toISOString(),
    });

    await Promise.all(
      subscriptions.map(async (subscription) => {
        let keys: { p256dh: string; auth: string };
        try {
          keys = JSON.parse(subscription.keysJson) as {
            p256dh: string;
            auth: string;
          };
        } catch {
          this.logger.warn("Web push subscription skipped: invalid keysJson", {
            subscriptionId: subscription.id,
          });
          return;
        }

        try {
          await webpush.sendNotification(
            {
              endpoint: subscription.endpoint,
              keys,
            },
            payload,
          );
        } catch (error) {
          const statusCode = getStatusCode(error);

          if (statusCode === 404 || statusCode === 410) {
            this.pushSubscriptionRepo.deleteByEndpoint(
              subscription.endpoint,
              subscription.userId ?? undefined,
            );
            this.logger.info("Web push subscription removed after permanent failure", {
              endpoint: subscription.endpoint,
              statusCode,
            });
            return;
          }

          this.logger.warn("Web push notification send failed", {
            endpoint: subscription.endpoint,
            statusCode,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );
  }

  private isPushEnabledForEvent(eventType: string, userId: string | null): boolean {
    const pushEnabledKey = `notification.push.enabled.${eventType}`;
    const fallbackKey = `notification.enabled.${eventType}`;

    const pushValue = userId
      ? getUserScopedPreference(this.preferenceRepo, userId, pushEnabledKey)
      : this.preferenceRepo.get(pushEnabledKey);

    if (pushValue !== null) {
      return pushValue !== "false";
    }

    const fallbackValue = userId
      ? getUserScopedPreference(this.preferenceRepo, userId, fallbackKey)
      : this.preferenceRepo.get(fallbackKey);

    // Default remains enabled when no preference exists.
    return fallbackValue !== "false";
  }

  private isQuietHours(userId: string | null): boolean {
    const quietHoursJson = userId
      ? getUserScopedPreference(this.preferenceRepo, userId, "notification.quiet_hours")
      : this.preferenceRepo.get("notification.quiet_hours");

    if (!quietHoursJson) {
      return false;
    }

    try {
      const { start, end } = JSON.parse(quietHoursJson) as {
        start?: string;
        end?: string;
      };

      if (!start || !end) {
        return false;
      }

      const timezone = userId
        ? getUserScopedPreference(this.preferenceRepo, userId, "notification.timezone")
        : this.preferenceRepo.get("notification.timezone");

      const now = new Date();
      let currentMinutes: number;

      if (timezone) {
        try {
          const parts = new Intl.DateTimeFormat("en-US", {
            timeZone: timezone,
            hour: "numeric",
            minute: "numeric",
            hour12: false,
          }).formatToParts(now);

          const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
          const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
          currentMinutes = hour * 60 + minute;
        } catch {
          this.logger.warn("Invalid notification.timezone, falling back to server time", {
            timezone,
          });
          currentMinutes = now.getHours() * 60 + now.getMinutes();
        }
      } else {
        currentMinutes = now.getHours() * 60 + now.getMinutes();
      }

      const [startHour, startMinute] = start.split(":").map(Number);
      const [endHour, endMinute] = end.split(":").map(Number);
      const startMinutes = startHour * 60 + startMinute;
      const endMinutes = endHour * 60 + endMinute;

      if (startMinutes <= endMinutes) {
        return currentMinutes >= startMinutes && currentMinutes < endMinutes;
      }

      return currentMinutes >= startMinutes || currentMinutes < endMinutes;
    } catch {
      this.logger.warn("Invalid quiet hours preference, ignoring", {
        raw: quietHoursJson,
      });
      return false;
    }
  }
}

function getStatusCode(error: unknown): number | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const value = (error as { statusCode?: unknown }).statusCode;
  return typeof value === "number" ? value : null;
}
