import { describe, it, expect } from "vitest";
import { ExternalCallError, personalActor } from "@oneon/domain";
import { harness, probeDefinition, request } from "../__tests__/orchestrator-harness.js";

async function created(h: ReturnType<typeof harness>, overrides = {}) {
  const outcome = await h.orchestrator.requestAction(request(overrides));
  if (outcome.kind === "refused") throw new Error(`refused: ${outcome.reason}`);
  return outcome.instance;
}

describe("requestAction", () => {
  it("runs an auto action through to completed", async () => {
    const h = harness();
    const instance = await created(h);
    expect(instance.status).toBe("completed");
    expect(h.repo.trail(instance.id)).toEqual(["proposed", "validating", "approved", "executing", "verifying", "completed"]);
    expect(instance.result).toEqual({ done: true });
    expect(instance.undo).toEqual({ token: "t" });
    expect(instance.executorRequestId).toBe("00000000000040008000000000000001");
  });

  it("returns the existing instance for a duplicate and records nothing", async () => {
    const h = harness();
    const first = await created(h);
    const before = h.repo.events.length;
    const second = await h.orchestrator.requestAction(request());
    expect(second).toMatchObject({ kind: "duplicate", instance: { id: first.id, status: "completed" } });
    expect(h.repo.events.length).toBe(before);
  });

  it.each([
    ["an unregistered type", request({ type: "create_purchase_order" }), "unknown_type"],
    ["invalid input", request({ input: { n: "one" } }), "invalid_input"],
    ["unknown keys", request({ input: { n: 1, tenantId: "t1" } }), "invalid_input"],
    ["a scope mismatch", request({ actor: { ...personalActor("u1"), scope: "tenant", tenantId: "t1" } }), "scope_mismatch"],
  ])("refuses %s without creating an instance", async (_name, req, reason) => {
    const h = harness();
    const outcome = await h.orchestrator.requestAction(req);
    expect(outcome).toMatchObject({ kind: "refused", reason });
    expect(h.repo.instances.size).toBe(0);
  });

  it("reports invalid input issues the AI can act on", async () => {
    const outcome = await harness().orchestrator.requestAction(request({ input: {} }));
    expect(outcome).toEqual({ kind: "refused", reason: "invalid_input", issues: ["n: Required"] });
  });
});

describe("advance: validation", () => {
  it("stops at awaiting_approval and notifies", async () => {
    const def = probeDefinition({ defaults: { ...probeDefinition().defaults, approval: { mode: "always", thresholds: {} } } });
    const h = harness([def]);
    const instance = await created(h);
    expect(instance.status).toBe("awaiting_approval");
    expect(h.notifier.awaitingApproval).toHaveBeenCalledWith(expect.objectContaining({ id: instance.id }), "Probe 1");
  });

  it("rejects when there is no executor", async () => {
    const instance = await created(harness([probeDefinition({ execute: null, unavailableReason: "needs Gmail modify access (gmail.modify)" })]));
    expect(instance.status).toBe("rejected");
    expect(instance.decision).toMatchObject({ outcome: "refuse", reasons: [{ code: "executor_unavailable" }] });
  });

  it("cancels on an obsolete precondition and fails on a blocking one", async () => {
    const obsolete = await created(harness([probeDefinition({ preconditions: async () => [{ id: "deadline_open", kind: "obsolete", passed: false }] })]));
    expect(obsolete).toMatchObject({ status: "cancelled", error: { code: "deadline_open", stage: "validation" } });
    const blocking = await created(harness([probeDefinition({ preconditions: async () => [{ id: "calendar_connected", kind: "blocking", passed: false }] })]));
    expect(blocking).toMatchObject({ status: "failed", error: { code: "calendar_connected", stage: "validation" } });
  });

  it("stays in validating when preconditions cannot be read", async () => {
    const instance = await created(harness([probeDefinition({ preconditions: async () => { throw new Error("Google down"); } })]));
    expect(instance.status).toBe("validating");
  });

  it("fails when resolve fails", async () => {
    const instance = await created(
      harness([probeDefinition({ resolve: async () => ({ ok: false, error: { code: "event_not_found", message: "gone", stage: "validation" } }) })]),
    );
    expect(instance).toMatchObject({ status: "failed", error: { code: "event_not_found" } });
  });
});

describe("advance: execution and verification", () => {
  it("fails on a definite executor failure", async () => {
    const instance = await created(harness([probeDefinition({ execute: async () => ({ kind: "definite_failure", code: "changed_since", message: "412" }) })]));
    expect(instance).toMatchObject({ status: "failed", error: { code: "changed_since", stage: "execution" } });
  });

  it("verifies an unknown outcome and completes when the effect exists", async () => {
    const instance = await created(harness([probeDefinition({ execute: async () => ({ kind: "unknown", code: "timeout", message: "slow" }) })]));
    expect(instance.status).toBe("completed");
    expect(instance.error).toBeNull();
  });

  it("treats a thrown error as unknown, then fails if the effect is still absent after the recovery threshold", async () => {
    const h = harness([
      probeDefinition({
        execute: async () => { throw new TypeError("socket hang up"); },
        postconditions: async () => ({ effectCheckId: "effect", checks: [{ id: "effect", passed: false }] }),
      }),
    ]);
    const instance = await created(h);
    expect(instance).toMatchObject({ status: "verifying", error: { code: "unexpected_error", stage: "execution" } });
    h.advanceClock(2 * 60_000);
    await h.orchestrator.sweep("u1");
    expect(h.repo.findById("u1", instance.id)).toMatchObject({ status: "failed", error: { code: "effect_absent", stage: "verification" } });
  });

  it("maps ExternalCallError outcomes", async () => {
    const instance = await created(harness([probeDefinition({ execute: async () => { throw new ExternalCallError("definite", "rejected_by_google", "400"); } })]));
    expect(instance).toMatchObject({ status: "failed", error: { code: "rejected_by_google" } });
  });

  it("times out to unknown and verifies", async () => {
    const instance = await created(harness([probeDefinition({ executionTimeoutMs: 10, execute: () => new Promise(() => {}) })]));
    expect(instance.status).toBe("completed");
  });

  it("reports a partial result", async () => {
    const instance = await created(
      harness([
        probeDefinition({
          postconditions: async () => ({ effectCheckId: "effect", checks: [{ id: "effect", passed: true }, { id: "attendees_match", passed: false }] }),
        }),
      ]),
    );
    expect(instance).toMatchObject({ status: "partially_completed", error: { code: "checks_failed" } });
  });

  it("stays in verifying when the outcome cannot be read", async () => {
    const instance = await created(harness([probeDefinition({ postconditions: async () => { throw new Error("Google down"); } })]));
    expect(instance.status).toBe("verifying");
  });

  it("records when each verification attempt ran, for the card's \"last checked\" time", async () => {
    const h = harness([probeDefinition({ postconditions: async () => { throw new Error("Google down"); } })]);
    const instance = await created(h);
    expect(h.repo.findById("u1", instance.id)!.lastHeartbeatAt).toBe("2026-10-01T12:00:00.000Z");
    h.advanceClock(7 * 60_000);
    await h.orchestrator.advance("u1", instance.id);
    expect(h.repo.findById("u1", instance.id)).toMatchObject({ status: "verifying", lastHeartbeatAt: "2026-10-01T12:07:00.000Z" });
  });
});

describe("advance: re-check before execution", () => {
  it("fails with changed_since_approval when consequences changed", async () => {
    let calls = 0;
    const instance = await created(
      harness([probeDefinition({ resolve: async () => ({ ok: true, resolved: { metrics: { others_involved: calls++ } } }) })]),
    );
    expect(instance).toMatchObject({ status: "failed", error: { code: "changed_since_approval", stage: "recheck" } });
  });

  it("fails with approval_required_now when policy became stricter", async () => {
    // The definition saves a stricter config between validation and the pre-execution re-check.
    const holder: { save?: () => void } = {};
    let calls = 0;
    const def = probeDefinition({
      resolve: async () => {
        if (calls++ === 1) holder.save?.();
        return { ok: true, resolved: { metrics: {} } };
      },
    });
    const h = harness([def]);
    holder.save = () =>
      h.configRepo.save({ scope: "personal", ownerId: "u1", actionType: "probe", configJson: '{"approval":{"mode":"always"}}', changedBy: "u1" });
    const outcome = await h.orchestrator.requestAction(request());
    if (outcome.kind === "refused") throw new Error();
    expect(outcome.instance).toMatchObject({ status: "failed", error: { code: "approval_required_now", stage: "recheck" } });
  });
});

describe("advance: a timed-out write may still land (C1)", () => {
  const MIN = 60_000;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("aborts the executor's signal when the definition's timeout passes", async () => {
    let signal: AbortSignal | undefined;
    const instance = await created(
      harness([probeDefinition({ executionTimeoutMs: 10, execute: (ctx) => { signal = ctx.signal; return new Promise(() => {}); } })]),
    );
    expect(instance.status).toBe("completed");
    expect(signal?.aborted).toBe(true);
  });

  it("stays in verifying instead of failing, then completes once the late effect is visible", async () => {
    // Reviewer's scenario: the executor resolves after the timeout and the effect lands afterwards.
    let landed = false;
    const h = harness([
      probeDefinition({
        executionTimeoutMs: 20,
        recoveryThresholdMs: 5 * MIN,
        execute: () => new Promise((resolve) => setTimeout(() => { landed = true; resolve({ kind: "succeeded", result: {}, undoData: null }); }, 80)),
        postconditions: async () => ({ effectCheckId: "effect", checks: [{ id: "effect", passed: landed }] }),
      }),
    ]);
    const instance = await created(h);
    expect(instance).toMatchObject({ status: "verifying", error: { code: "timeout", stage: "execution" } });

    // Re-verifying before the recovery threshold still must not conclude "no effect".
    h.advanceClock(1 * MIN);
    expect((await h.orchestrator.advance("u1", instance.id)).status).toBe("verifying");

    await sleep(100);
    expect(landed).toBe(true);
    h.advanceClock(5 * MIN);
    await h.orchestrator.sweep("u1");
    expect(h.repo.findById("u1", instance.id)!.status).toBe("completed");
    expect(h.repo.trail(instance.id)).not.toContain("failed");
  });

  it("records failed / effect_absent only once the recovery threshold has passed", async () => {
    const h = harness([
      probeDefinition({
        recoveryThresholdMs: 5 * MIN,
        execute: async () => ({ kind: "unknown", code: "google_unavailable", message: "503" }),
        postconditions: async () => ({ effectCheckId: "effect", checks: [{ id: "effect", passed: false }] }),
      }),
    ]);
    const instance = await created(h);
    expect(instance.status).toBe("verifying");
    h.advanceClock(6 * MIN);
    await h.orchestrator.sweep("u1");
    expect(h.repo.findById("u1", instance.id)).toMatchObject({ status: "failed", error: { code: "effect_absent", stage: "verification" } });
  });

  it("still fails at once when the executor succeeded but the effect is absent", async () => {
    const instance = await created(
      harness([probeDefinition({ postconditions: async () => ({ effectCheckId: "effect", checks: [{ id: "effect", passed: false }] }) })]),
    );
    expect(instance).toMatchObject({ status: "failed", error: { code: "effect_absent" } });
  });
});
