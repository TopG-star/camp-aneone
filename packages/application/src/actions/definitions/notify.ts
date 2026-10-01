import { z } from "zod";
import { NotificationEventType } from "@oneon/domain";
import { emailKey } from "../idempotency.js";
import { DEFAULT_RECOVERY_THRESHOLD_MS, PERSONAL_APPROVERS, type ActionDefinition, type Resolved } from "../definition.js";

const inputSchema = z
  .object({
    inboundItemId: z.string().min(1),
    title: z.string().min(1),
    body: z.string(),
    deepLink: z.string().min(1),
  })
  .strict();

export type NotifyInput = z.infer<typeof inputSchema>;
export interface NotifyResolved extends Resolved {
  eventType: "urgent_item";
}

const floor = {
  risk: "L1" as const,
  approval: { mode: "auto" as const, thresholds: {} },
  requiredPermissions: [],
  approverRoles: PERSONAL_APPROVERS,
  expiryHours: 168,
};

export const notifyDefinition: ActionDefinition<NotifyInput, NotifyResolved> = {
  type: "notify",
  version: "1",
  scope: "personal",
  label: "Notify me",
  description: "Send an in-app notification about an urgent email.",
  inputSchema,
  effects: { reads: ["notification preferences"], writes: ["in-app notification", "web push"] },
  floor,
  defaults: { ...floor, enabled: true },
  thresholdMetrics: {},
  rollbackClass: "irreversible",
  recoveryThresholdMs: DEFAULT_RECOVERY_THRESHOLD_MS,
  executionTimeoutMs: 10_000,
  disableWarning: "Turning this off stops urgent-email notifications.",
  unavailableReason: null,
  consequenceKeys: [],
  idempotencyKey: (input) => emailKey(input.inboundItemId),

  async preconditions({ actor, readers, now }) {
    const reason = readers.notifications.isSuppressed(actor.userId, NotificationEventType.UrgentItem, now);
    return [{ id: "not_suppressed", kind: "obsolete", passed: reason === null, expected: "deliverable", actual: reason ?? "deliverable" }];
  },

  async resolve() {
    return { ok: true, resolved: { metrics: {}, eventType: "urgent_item" } };
  },

  riskFor: (_resolved, floorRisk) => floorRisk,
  describe: (_resolved, input) => `Notify you: "${input.title}".`,

  async execute({ input, actor, writers }) {
    if (!writers.notifications) {
      return { kind: "definite_failure", code: "notifications_unavailable", message: "Notifications are not configured." };
    }
    const sent = await writers.notifications.deliver({
      eventType: NotificationEventType.UrgentItem,
      title: input.title,
      body: input.body,
      deepLink: input.deepLink,
      userId: actor.userId,
    });
    if (sent.status === "suppressed") {
      return {
        kind: "definite_failure",
        code: `suppressed_${sent.reason}`,
        message: sent.reason === "quiet_hours" ? "Not sent: quiet hours began" : "Not sent: notification type turned off",
      };
    }
    return { kind: "succeeded", result: { notificationId: sent.notificationId }, undoData: null };
  },

  async postconditions({ result, readers }) {
    const id = typeof result?.notificationId === "string" ? result.notificationId : null;
    const exists = id !== null && readers.notifications.findById(id) !== null;
    return {
      effectCheckId: "notification_exists",
      checks: [{ id: "notification_exists", passed: exists, expected: id, actual: exists ? id : null }],
    };
  },

  undo: null,
};
