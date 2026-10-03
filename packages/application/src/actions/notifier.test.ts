import { describe, it, expect, vi } from "vitest";
import type { ActionInstance } from "@oneon/domain";
import { createActionNotifier } from "./notifier.js";
import { silentLogger } from "./__tests__/orchestrator-harness.js";

const instance = { id: "a1", userId: "u1", actionType: "create_reminder" } as ActionInstance;

describe("createActionNotifier", () => {
  it("sends an approval notification with a deep link", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await createActionNotifier({ send }, silentLogger).awaitingApproval(instance, 'Add an all-day reminder "Due: Q4" on 7 Oct 2026 to your calendar.');
    expect(send).toHaveBeenCalledWith({
      eventType: "action_proposed",
      title: "Action needs your approval",
      body: 'Add an all-day reminder "Due: Q4" on 7 Oct 2026 to your calendar.',
      deepLink: "/actions#action-a1",
      userId: "u1",
    });
  });

  it("sends a rollback-failed notification", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await createActionNotifier({ send }, silentLogger).rollbackFailed(instance, "Undo of reminder");
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ eventType: "action_rollback_failed", title: "Undo failed — needs a manual fix" }));
  });
});
