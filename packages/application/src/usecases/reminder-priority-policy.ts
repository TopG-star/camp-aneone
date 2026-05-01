import type { Priority, RiskLevel } from "@oneon/domain";
import { NotificationEventType } from "@oneon/domain";

const URGENT_PRIORITY_THRESHOLD: Priority = 2;

export type ReminderPriorityPolicyReason =
  | "urgent_priority_within_threshold"
  | "urgent_priority_below_threshold"
  | "action_requires_approval"
  | "action_auto_risk_not_notified"
  | "deadline_approaching_default_allow";

interface ReminderPriorityPolicyBaseInput {
  userId: string;
}

export type ReminderPriorityPolicyInput =
  | (ReminderPriorityPolicyBaseInput & {
      eventType: typeof NotificationEventType.UrgentItem;
      priority: Priority;
    })
  | (ReminderPriorityPolicyBaseInput & {
      eventType: typeof NotificationEventType.ActionProposed;
      riskLevel: RiskLevel;
    })
  | (ReminderPriorityPolicyBaseInput & {
      eventType: typeof NotificationEventType.DeadlineApproaching;
      confidence?: number;
    });

export interface ReminderPriorityPolicyDecision {
  shouldNotify: boolean;
  eventType: ReminderPriorityPolicyInput["eventType"];
  reason: ReminderPriorityPolicyReason;
  policy: {
    name: "reminder_priority_policy";
    version: 1;
  };
  details: Record<string, string | number | boolean | null>;
}

export function evaluateReminderPriorityPolicy(
  input: ReminderPriorityPolicyInput,
): ReminderPriorityPolicyDecision {
  switch (input.eventType) {
    case NotificationEventType.UrgentItem: {
      const shouldNotify = input.priority <= URGENT_PRIORITY_THRESHOLD;
      return {
        shouldNotify,
        eventType: input.eventType,
        reason: shouldNotify
          ? "urgent_priority_within_threshold"
          : "urgent_priority_below_threshold",
        policy: { name: "reminder_priority_policy", version: 1 },
        details: {
          userId: input.userId,
          priority: input.priority,
          threshold: URGENT_PRIORITY_THRESHOLD,
        },
      };
    }

    case NotificationEventType.ActionProposed: {
      const shouldNotify = input.riskLevel === "approval_required";
      return {
        shouldNotify,
        eventType: input.eventType,
        reason: shouldNotify
          ? "action_requires_approval"
          : "action_auto_risk_not_notified",
        policy: { name: "reminder_priority_policy", version: 1 },
        details: {
          userId: input.userId,
          riskLevel: input.riskLevel,
        },
      };
    }

    case NotificationEventType.DeadlineApproaching:
    default:
      return {
        shouldNotify: true,
        eventType: input.eventType,
        reason: "deadline_approaching_default_allow",
        policy: { name: "reminder_priority_policy", version: 1 },
        details: {
          userId: input.userId,
          confidence: input.confidence ?? null,
        },
      };
  }
}
