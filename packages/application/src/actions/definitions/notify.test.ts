import { describe, it, expect, vi } from "vitest";
import { personalActor } from "@oneon/domain";
import { notifyDefinition as def } from "./notify.js";
import { fakeReaders, fakeWriters, notification } from "../__tests__/fakes.js";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const input = { inboundItemId: "i1", title: "Urgent: Q4 review", body: "Boss needs numbers", deepLink: "/items/i1" };
const actor = personalActor("u1");

describe("notify", () => {
  it("is obsolete during quiet hours", async () => {
    const readers = fakeReaders({ notifications: { isSuppressed: () => "quiet_hours", findById: () => null } });
    expect(await def.preconditions({ input, actor, readers, now: NOW })).toEqual([
      { id: "not_suppressed", kind: "obsolete", passed: false, expected: "deliverable", actual: "quiet_hours" },
    ]);
  });

  it("delivers and returns the notification id", async () => {
    const deliver = vi.fn().mockResolvedValue({ status: "delivered", notificationId: "n-1" });
    const outcome = await def.execute!({
      instanceId: "a1", input, resolved: { metrics: {}, eventType: "urgent_item" }, actor,
      executorRequestId: "a1", writers: fakeWriters({ notifications: { deliver } }), signal: new AbortController().signal, heartbeat: () => {}, now: NOW,
    });
    expect(outcome).toEqual({ kind: "succeeded", result: { notificationId: "n-1" }, undoData: null });
    expect(deliver).toHaveBeenCalledWith({ eventType: "urgent_item", title: input.title, body: input.body, deepLink: "/items/i1", userId: "u1" });
  });

  it("reports suppression at send time as a definite failure", async () => {
    const deliver = vi.fn().mockResolvedValue({ status: "suppressed", reason: "quiet_hours" });
    const outcome = await def.execute!({
      instanceId: "a1", input, resolved: { metrics: {}, eventType: "urgent_item" }, actor,
      executorRequestId: "a1", writers: fakeWriters({ notifications: { deliver } }), signal: new AbortController().signal, heartbeat: () => {}, now: NOW,
    });
    expect(outcome).toEqual({ kind: "definite_failure", code: "suppressed_quiet_hours", message: "Not sent: quiet hours began" });
  });

  it("verifies the notification exists", async () => {
    const readers = fakeReaders({ notifications: { isSuppressed: () => null, findById: (id) => (id === "n-1" ? notification("n-1") : null) } });
    const ok = await def.postconditions!({ input, resolved: { metrics: {}, eventType: "urgent_item" }, result: { notificationId: "n-1" }, executorRequestId: "a1", readers });
    expect(ok).toEqual({ effectCheckId: "notification_exists", checks: [{ id: "notification_exists", passed: true, expected: "n-1", actual: "n-1" }] });
    const missing = await def.postconditions!({ input, resolved: { metrics: {}, eventType: "urgent_item" }, result: null, executorRequestId: "a1", readers });
    expect(missing.checks[0].passed).toBe(false);
  });

  it("is irreversible, auto by default, and warns when disabled", () => {
    expect(def.rollbackClass).toBe("irreversible");
    expect(def.undo).toBeNull();
    expect(def.defaults.approval.mode).toBe("auto");
    expect(def.disableWarning).toBe("Turning this off stops urgent-email notifications.");
    expect(def.idempotencyKey(input, { source: "rule", resourceId: "i1" })).toBe("email:i1");
  });
});
