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
    if (!this.isPushEnabledForEvent(notification.eventType, notification.userId ?? null)) {
      this.logger.debug("Web push suppressed: event type disabled", {
        eventType: notification.eventType,
      });
      return;
    }

    const subscriptions = notification.userId
      ? this.pushSubscriptionRepo.findByUserId(notification.userId)
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
}

function getStatusCode(error: unknown): number | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const value = (error as { statusCode?: unknown }).statusCode;
  return typeof value === "number" ? value : null;
}
