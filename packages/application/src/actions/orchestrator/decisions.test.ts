import { describe, it, expect } from "vitest";
import { personalActor } from "@oneon/domain";
import { harness, probeDefinition, request } from "../__tests__/orchestrator-harness.js";
import { ActionOperationError } from "./types.js";

const askFirst = () => probeDefinition({ defaults: { ...probeDefinition().defaults, approval: { mode: "always", thresholds: {} } } });

async function waiting(h: ReturnType<typeof harness>) {
  const o = await h.orchestrator.requestAction(request());
  if (o.kind === "refused") throw new Error();
  return o.instance;
}

describe("approve / reject / cancel", () => {
  it("approves and runs to completion", async () => {
    const h = harness([askFirst()]);
    const w = await waiting(h);
    const done = await h.orchestrator.approve(personalActor("u1"), w.id);
    expect(done.status).toBe("completed");
    expect(h.repo.events.find((e) => e.toStatus === "approved")!.actor).toEqual({ kind: "user", userId: "u1" });
  });

  it("refuses a second approve as a conflict", async () => {
    const h = harness([askFirst()]);
    const w = await waiting(h);
    await h.orchestrator.approve(personalActor("u1"), w.id);
    await expect(h.orchestrator.approve(personalActor("u1"), w.id)).rejects.toMatchObject({ code: "conflict" });
  });

  it("hides another user's action", async () => {
    const h = harness([askFirst()]);
    const w = await waiting(h);
    await expect(h.orchestrator.approve(personalActor("u2"), w.id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("expires instead of approving once the approval window has passed (M1)", async () => {
    let executions = 0;
    const def = askFirst();
    const h = harness([{ ...def, execute: async () => { executions++; return { kind: "succeeded", result: {}, undoData: null }; } }]);
    const w = await waiting(h);
    h.advanceClock(24 * 3_600_000 + 1);
    const after = await h.orchestrator.approve(personalActor("u1"), w.id);
    expect(after.status).toBe("expired");
    expect(h.repo.trail(w.id)).not.toContain("approved");
    expect(executions).toBe(0);
  });

  it("still approves just inside the approval window", async () => {
    const h = harness([askFirst()]);
    const w = await waiting(h);
    h.advanceClock(24 * 3_600_000);
    expect((await h.orchestrator.approve(personalActor("u1"), w.id)).status).toBe("completed");
  });

  it("rejects instead of approving when policy now refuses", async () => {
    const h = harness([askFirst()]);
    const w = await waiting(h);
    h.configRepo.save({ scope: "personal", ownerId: "u1", actionType: "probe", configJson: '{"enabled":false}', changedBy: "u1" });
    const after = await h.orchestrator.approve(personalActor("u1"), w.id);
    expect(after.status).toBe("rejected");
    expect(h.repo.events.at(-1)!.actor).toEqual({ kind: "policy" });
  });

  it("rejects and cancels with a reason", async () => {
    const h = harness([askFirst()]);
    const a = await waiting(h);
    expect((await h.orchestrator.reject(personalActor("u1"), a.id, "not now")).status).toBe("rejected");
    const b = await h.orchestrator.requestAction(request({ keyContext: { source: "rule", resourceId: "r2" } }));
    if (b.kind === "refused") throw new Error();
    expect((await h.orchestrator.cancel(personalActor("u1"), b.instance.id)).status).toBe("cancelled");
  });

  it("refuses to cancel a completed action", async () => {
    const h = harness();
    const o = await h.orchestrator.requestAction(request());
    if (o.kind === "refused") throw new Error();
    await expect(h.orchestrator.cancel(personalActor("u1"), o.instance.id)).rejects.toBeInstanceOf(ActionOperationError);
  });
});

describe("retry", () => {
  it("creates a linked attempt with a suffixed key, and retries of retries use the root key", async () => {
    let fail = true;
    const h = harness([probeDefinition({ execute: async () => (fail ? { kind: "definite_failure", code: "x", message: "x" } : { kind: "succeeded", result: {}, undoData: null }) })]);
    const first = await h.orchestrator.requestAction(request());
    if (first.kind === "refused") throw new Error();
    expect(first.instance.status).toBe("failed");

    const second = await h.orchestrator.retry(personalActor("u1"), first.instance.id);
    if (second.kind === "refused") throw new Error();
    expect(second.instance).toMatchObject({ retryOf: first.instance.id, attemptNumber: 2, idempotencyKey: "rule:r1:retry:1", status: "failed" });

    fail = false;
    const third = await h.orchestrator.retry(personalActor("u1"), second.instance.id);
    if (third.kind === "refused") throw new Error();
    expect(third.instance).toMatchObject({ attemptNumber: 3, idempotencyKey: "rule:r1:retry:2", status: "completed" });
  });

  it("is not allowed on a completed action", async () => {
    const h = harness();
    const o = await h.orchestrator.requestAction(request());
    if (o.kind === "refused") throw new Error();
    await expect(h.orchestrator.retry(personalActor("u1"), o.instance.id)).rejects.toMatchObject({ code: "not_allowed" });
  });
});
