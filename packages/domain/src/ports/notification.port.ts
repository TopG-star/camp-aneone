export interface NotificationPort {
  send(notification: {
    eventType: string;
    title: string;
    body: string;
    deepLink?: string;
    userId?: string | null;
  }): Promise<void>;
}

export type NotificationSendResult =
  | { status: "delivered"; notificationId: string }
  | { status: "suppressed"; reason: "quiet_hours" | "type_disabled" };

/** Used by the notify executor; reports what happened instead of returning void. */
export interface NotificationWriter {
  deliver(notification: {
    eventType: string;
    title: string;
    body: string;
    deepLink?: string;
    userId: string;
  }): Promise<NotificationSendResult>;
}
