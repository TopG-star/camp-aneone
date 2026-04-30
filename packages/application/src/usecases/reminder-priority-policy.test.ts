import { describe, expect, it } from "vitest";
import { NotificationEventType } from "@oneon/domain";
import { evaluateReminderPriorityPolicy } from "./reminder-priority-policy.js";

describe("evaluateReminderPriorityPolicy", () => {
  it("allows urgent item notifications when priority is <= 2", () => {
    const decision = evaluateReminderPriorityPolicy({
      eventType: NotificationEventType.UrgentItem,
      userId: "user-1",
      priority: 2,
    });

    expect(decision.shouldNotify).toBe(true);
    expect(decision.reason).toBe("urgent_priority_within_threshold");
    expect(decision.policy.name).toBe("reminder_priority_policy");
    expect(decision.policy.version).toBe(1);
    expect(decision.details).toEqual(
      expect.objectContaining({
        threshold: 2,
        priority: 2,
      }),
    );
  });

  it("suppresses urgent item notifications when priority is > 2", () => {
    const decision = evaluateReminderPriorityPolicy({
      eventType: NotificationEventType.UrgentItem,
      userId: "user-1",
      priority: 4,
    });

    expect(decision.shouldNotify).toBe(false);
    expect(decision.reason).toBe("urgent_priority_below_threshold");
  });

  it("allows action proposed notifications only for approval required risk", () => {
    const allowed = evaluateReminderPriorityPolicy({
      eventType: NotificationEventType.ActionProposed,
      userId: "user-1",
      riskLevel: "approval_required",
    });

    const suppressed = evaluateReminderPriorityPolicy({
      eventType: NotificationEventType.ActionProposed,
      userId: "user-1",
      riskLevel: "auto",
    });

    expect(allowed.shouldNotify).toBe(true);
    expect(allowed.reason).toBe("action_requires_approval");
    expect(suppressed.shouldNotify).toBe(false);
    expect(suppressed.reason).toBe("action_auto_risk_not_notified");
  });

  it("allows deadline approaching notifications by default", () => {
    const decision = evaluateReminderPriorityPolicy({
      eventType: NotificationEventType.DeadlineApproaching,
      userId: "user-1",
      confidence: 0.63,
    });

    expect(decision.shouldNotify).toBe(true);
    expect(decision.reason).toBe("deadline_approaching_default_allow");
    expect(decision.details).toEqual(
      expect.objectContaining({
        confidence: 0.63,
      }),
    );
  });
});
