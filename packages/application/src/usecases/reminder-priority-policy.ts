import type { Priority } from "@oneon/domain";
import { NotificationEventType } from "@oneon/domain";

const URGENT_PRIORITY_THRESHOLD: Priority = 2;
const DEADLINE_CONFIDENCE_THRESHOLD = 0.7;

export type ReminderPriorityPolicyReason =
  | "urgent_priority_within_threshold"
  | "urgent_priority_below_threshold"
  | "deadline_confidence_within_threshold"
  | "deadline_confidence_below_threshold";

interface ReminderPriorityPolicyBaseInput {
  userId: string;
}

export type ReminderPriorityPolicyInput =
  | (ReminderPriorityPolicyBaseInput & {
      eventType: typeof NotificationEventType.UrgentItem;
      priority: Priority;
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

    case NotificationEventType.DeadlineApproaching:
    default: {
      const confidence = input.confidence ?? 0;
      const shouldNotify = confidence >= DEADLINE_CONFIDENCE_THRESHOLD;

      return {
        shouldNotify,
        eventType: input.eventType,
        reason: shouldNotify
          ? "deadline_confidence_within_threshold"
          : "deadline_confidence_below_threshold",
        policy: { name: "reminder_priority_policy", version: 1 },
        details: {
          userId: input.userId,
          confidence,
          threshold: DEADLINE_CONFIDENCE_THRESHOLD,
        },
      };
    }
  }
}
