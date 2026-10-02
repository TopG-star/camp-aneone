import { describe, it, expect } from "vitest";
import { personalActor } from "@oneon/domain";
import { harness, probeDefinition, request } from "../__tests__/orchestrator-harness.js";

const MIN = 60_000;

describe("sweep", () => {
  it("re-verifies a stuck verifying action every cycle, even right after a verification attempt (§10.5)", async () => {
    const h = harness([probeDefinition({ postconditions: async () => { throw new Error("Google down"); } })]);
    const o = await h.orchestrator.requestAction(request());
    if (o.kind === "refused") throw new Error();
    expect(o.instance.status).toBe("verifying");
    h.advanceClock(2 * MIN);
    // A verification attempt just ran (it records the "last checked" time in the heartbeat column).
    h.repo.recordHeartbeat(o.instance.id, new Date(Date.parse(o.instance.updatedAt) + 2 * MIN).toISOString());
    expect(await h.orchestrator.sweep("u1")).toEqual({ recovered: 1 });
  });


  it("leaves fresh in-progress actions alone and honours each definition's threshold", async () => {
    const h = harness([probeDefinition({ recoveryThresholdMs: 10 * MIN, preconditions: async () => { throw new Error("down"); } })]);
    const o = await h.orchestrator.requestAction(request());
    if (o.kind === "refused") throw new Error();
    expect(o.instance.status).toBe("validating");
    h.advanceClock(5 * MIN);
    expect(await h.orchestrator.sweep("u1")).toEqual({ recovered: 0 });
  });

  it("re-runs validation for an action stuck in validating", async () => {
    let down = true;
    const h = harness([probeDefinition({ preconditions: async () => { if (down) throw new Error("down"); return []; } })]);
    const o = await h.orchestrator.requestAction(request());
    if (o.kind === "refused") throw new Error();
    down = false;
    h.advanceClock(2 * MIN);
    expect(await h.orchestrator.sweep("u1")).toEqual({ recovered: 1 });
    expect(h.repo.findById("u1", o.instance.id)!.status).toBe("completed");
  });

  it("moves a stuck proposed action through validating first", async () => {
    const h = harness();
    const { instance } = h.repo.create(
      { id: "a-p", scope: "personal", ownerId: "u1", userId: "u1", tenantId: null, locationIds: [], actionType: "probe", definitionVersion: "1", initiator: "rule:test", initiatorUserId: null, input: { n: 1 }, evidence: [], idempotencyKey: "rule:x", retryOf: null, attemptNumber: 1, resourceRef: null },
      { kind: "system" },
    );
    h.advanceClock(2 * MIN);
    await h.orchestrator.sweep("u1");
    expect(h.repo.trail(instance.id).slice(0, 3)).toEqual(["proposed", "validating", "approved"]);
  });

  it("verifies an action stuck in executing without re-running the executor", async () => {
    let executions = 0;
    const h = harness([probeDefinition({ execute: async () => { executions++; return { kind: "succeeded", result: {}, undoData: null }; } })]);
    // Simulate a crash after the executor was called: the action is left in executing.
    const { instance } = h.repo.create(
      { id: "a-e", scope: "personal", ownerId: "u1", userId: "u1", tenantId: null, locationIds: [], actionType: "probe", definitionVersion: "1", initiator: "rule:test", initiatorUserId: null, input: { n: 1 }, evidence: [], idempotencyKey: "rule:e", retryOf: null, attemptNumber: 1, resourceRef: null },
      { kind: "system" },
    );
    h.repo.appendTransition({ actionId: instance.id, expectedStatus: "proposed", toStatus: "validating", actor: { kind: "system" } });
    h.repo.appendTransition({ actionId: instance.id, expectedStatus: "validating", toStatus: "approved", actor: { kind: "policy" }, patch: { resolved: { metrics: {} }, decision: { outcome: "auto" } } });
    h.repo.appendTransition({ actionId: instance.id, expectedStatus: "approved", toStatus: "executing", actor: { kind: "system" }, patch: { executorRequestId: "ae" } });
    h.advanceClock(2 * MIN);
    await h.orchestrator.sweep("u1");
    expect(h.repo.findById("u1", instance.id)!.status).toBe("completed");
    expect(h.repo.trail(instance.id).slice(-3)).toEqual(["executing", "verifying", "completed"]);
    expect(executions).toBe(0);
  });

  it("cancels an approved action whose approval went stale", async () => {
    const h = harness([probeDefinition({ preconditions: async () => { throw new Error("down"); } })]);
    const { instance } = h.repo.create(
      { id: "a-s", scope: "personal", ownerId: "u1", userId: "u1", tenantId: null, locationIds: [], actionType: "probe", definitionVersion: "1", initiator: "user", initiatorUserId: "u1", input: { n: 1 }, evidence: [], idempotencyKey: "k", retryOf: null, attemptNumber: 1, resourceRef: null },
      { kind: "user", userId: "u1" },
    );
    h.repo.appendTransition({ actionId: instance.id, expectedStatus: "proposed", toStatus: "validating", actor: { kind: "system" } });
    h.repo.appendTransition({ actionId: instance.id, expectedStatus: "validating", toStatus: "approved", actor: { kind: "policy" }, patch: { resolved: { metrics: {} }, decision: { outcome: "auto", policy: { expiryHours: 24 } } } });
    h.advanceClock(25 * 60 * MIN);
    await h.orchestrator.sweep("u1");
    expect(h.repo.findById("u1", instance.id)).toMatchObject({ status: "cancelled" });
    expect(h.repo.events.at(-1)!.data).toEqual({ reason: "stale_approval" });
  });

  it("resumes an undo whose executor never ran, and fails one that was interrupted", async () => {
    const h = harness();
    const o = await h.orchestrator.requestAction(request());
    if (o.kind === "refused") throw new Error();
    h.repo.appendTransition({ actionId: o.instance.id, expectedStatus: "completed", toStatus: "rolling_back", actor: { kind: "user", userId: "u1" } });
    h.advanceClock(2 * MIN);
    await h.orchestrator.sweep("u1");
    expect(h.repo.findById("u1", o.instance.id)!.status).toBe("rolled_back");

    const h2 = harness([probeDefinition({ undo: { ...probeDefinition().undo!, verify: async () => [{ id: "undone", passed: false }] } })]);
    const o2 = await h2.orchestrator.requestAction(request());
    if (o2.kind === "refused") throw new Error();
    h2.repo.appendTransition({ actionId: o2.instance.id, expectedStatus: "completed", toStatus: "rolling_back", actor: { kind: "user", userId: "u1" } });
    h2.repo.markUndoStarted(o2.instance.id, "2026-10-01T12:00:00.000Z");
    h2.advanceClock(2 * MIN);
    await h2.orchestrator.sweep("u1");
    expect(h2.repo.findById("u1", o2.instance.id)).toMatchObject({ status: "rollback_failed", error: { code: "interrupted" } });
  });
});

describe("expireStale", () => {
  it("expires approvals past their window without notifying", async () => {
    const h = harness([probeDefinition({ defaults: { ...probeDefinition().defaults, approval: { mode: "always", thresholds: {} } } })]);
    const o = await h.orchestrator.requestAction(request());
    if (o.kind === "refused") throw new Error();
    h.notifier.awaitingApproval.mockClear();
    h.advanceClock(23 * 60 * MIN);
    expect(await h.orchestrator.expireStale("u1")).toBe(0);
    h.advanceClock(2 * 60 * MIN);
    expect(await h.orchestrator.expireStale("u1")).toBe(1);
    expect(h.repo.findById("u1", o.instance.id)!.status).toBe("expired");
    expect(h.notifier.awaitingApproval).not.toHaveBeenCalled();
    expect(h.notifier.rollbackFailed).not.toHaveBeenCalled();
    void personalActor;
  });
});
