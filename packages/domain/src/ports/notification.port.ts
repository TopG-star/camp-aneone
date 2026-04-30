export interface NotificationPort {
  send(notification: {
    eventType: string;
    title: string;
    body: string;
    deepLink?: string;
    userId?: string | null;
  }): Promise<void>;
}
