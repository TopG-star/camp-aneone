import { describe, it, expect } from "vitest";
import { personalActor, type ActionInstance, type LifecycleStatus } from "@oneon/domain";
import { createActionDefinitions, createActionRegistry } from "@oneon/application";
import { toActionView } from "./action-views.js";

const registry = createActionRegistry(createActionDefinitions());

function instance(overrides: Partial<ActionInstance>): ActionInstance {
  return {
    id: "a1", scope: "personal", ownerId: "u1", userId: "u1", tenantId: null, locationIds: [],
    actionType: "create_calendar_event", definitionVersion: "1", status: "completed", initiator: "user", initiatorUserId: "u1",
    input: {}, resolved: null, evidence: [], decision: null, result: null, error: null, undo: null,
    idempotencyKey: "k", retryOf: null, attemptNumber: 1, executorRequestId: "a1", executionStartedAt: null,
    lastHeartbeatAt: null, undoStartedAt: null, resourceRef: null, lastEventSeq: 1,
    createdAt: "2026-10-01T12:00:00.000Z", updatedAt: "2026-10-01T12:00:00.000Z",
    ...overrides,
  };
}

function view(overrides: Partial<ActionInstance>) {
  const i = instance(overrides);
  return toActionView(i, { registry, events: [], viewer: personalActor("u1"), policy: registry.get(i.actionType).defaults });
}

const UNDO_DATA = { eventId: "a1", versionAfter: '"v1"', sendUpdates: "none" };

describe("toActionView error text (I5)", () => {
  it("shows plain text, not the raw Google body, and keeps the code", () => {
    const v = view({
      status: "failed",
      error: { code: "rejected_by_google", message: 'Google Calendar API error 400: {"error":{"message":"Invalid start"}}', stage: "execution" },
    });
    expect(v.error).toEqual({ code: "rejected_by_google", stage: "execution", message: "Google Calendar refused the change, so nothing was changed." });
  });

  it("tells the owner what is left to fix by hand after rollback_failed", () => {
    const v = view({ status: "rollback_failed", error: { code: "changed_since", message: "Undo refused: changed_since", stage: "undo" } });
    expect(v.error?.message).toBe(
      "Someone changed this event after Oneon created it, so Oneon left it alone. Delete it in Google Calendar if you still want it gone.",
    );
  });
});

describe("toActionView undo text (I3)", () => {
  it("says it can be undone only while undo is offered", () => {
    expect(view({ status: "completed", undo: UNDO_DATA })).toMatchObject({ allowedOperations: ["undo"], undo: { text: "Can be undone" } });
  });

  it.each<LifecycleStatus>(["rejected", "rolled_back", "rollback_failed", "failed", "cancelled", "expired", "awaiting_approval"])(
    "shows no undo claim on a %s card",
    (status) => {
      expect(view({ status, undo: UNDO_DATA }).undo.text).toBeNull();
    },
  );

  it("is honest when an action completed without undo data", () => {
    expect(view({ status: "completed", undo: null })).toMatchObject({
      allowedOperations: [],
      undo: { text: "Oneon couldn't record how to undo this, so it can't be undone from here. Change it in Google Calendar if you need to." },
    });
  });

  it("keeps the irreversible warning on a pending or settled irreversible action", () => {
    expect(view({ actionType: "notify", status: "completed" }).undo.text).toBe("This action cannot be automatically reversed.");
    expect(view({ actionType: "notify", status: "awaiting_approval" }).undo.text).toBe("This action cannot be automatically reversed.");
    expect(view({ actionType: "notify", status: "rejected" }).undo.text).toBeNull();
  });
});

describe("toActionView last checked (I3)", () => {
  it("reports the latest verification attempt while verifying", () => {
    const v = view({ status: "verifying", updatedAt: "2026-10-01T12:00:00.000Z", lastHeartbeatAt: "2026-10-01T12:09:00.000Z" });
    expect(v.lastCheckedAt).toBe("2026-10-01T12:09:00.000Z");
    expect(view({ status: "verifying", lastHeartbeatAt: null }).lastCheckedAt).toBe("2026-10-01T12:00:00.000Z");
    expect(view({ status: "completed" }).lastCheckedAt).toBeNull();
  });
});
