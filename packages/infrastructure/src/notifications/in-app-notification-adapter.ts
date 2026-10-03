import type {
  NotificationPort,
  NotificationRepository,
  NotificationSendResult,
  NotificationWriter,
  PreferenceRepository,
  Logger,
} from "@oneon/domain";
import { evaluateNotificationSuppression } from "@oneon/domain";

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
export class InAppNotificationAdapter implements NotificationPort, NotificationWriter {
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
    await this.write(notification);
  }

  async deliver(notification: {
    eventType: string;
    title: string;
    body: string;
    deepLink?: string;
    userId: string;
  }): Promise<NotificationSendResult> {
    return this.write(notification);
  }

  private async write(notification: {
    eventType: string;
    title: string;
    body: string;
    deepLink?: string;
    userId?: string | null;
  }): Promise<NotificationSendResult> {
    const userId = notification.userId ?? null;
    const suppressed = evaluateNotificationSuppression(
      this.preferenceRepo,
      userId,
      notification.eventType,
      new Date(),
      (message, meta) => this.logger.warn(message, meta),
    );
    if (suppressed) {
      const logMessage = suppressed === "type_disabled"
        ? "Notification suppressed: event type disabled"
        : "Notification suppressed: quiet hours active";
      this.logger.debug(logMessage, { eventType: notification.eventType });
      return { status: "suppressed", reason: suppressed };
    }

    const created = this.notificationRepo.create({
      eventType: notification.eventType,
      title: notification.title,
      body: notification.body,
      deepLink: notification.deepLink ?? null,
      read: false,
      userId,
    });
    this.logger.info("Notification created", { id: created.id, eventType: notification.eventType });
    return { status: "delivered", notificationId: created.id };
  }
}
