export interface NotificationPort {
  send(notification: {
    eventType: string;
    title: string;
    body: string;
    deepLink?: string;
  }): Promise<void>;
}
