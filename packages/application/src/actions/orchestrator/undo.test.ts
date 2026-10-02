import { describe, it, expect } from "vitest";
import { personalActor } from "@oneon/domain";
import { harness, probeDefinition, request } from "../__tests__/orchestrator-harness.js";
import type { UndoSpec } from "../definition.js";

const baseUndo = probeDefinition().undo!;
const withUndo = (undo: Partial<UndoSpec<unknown, never>>) => probeDefinition({ undo: { ...baseUndo, ...undo } });

async function completed(h: ReturnType<typeof harness>) {
  const o = await h.orchestrator.requestAction(request());
  if (o.kind === "refused" || o.instance.status !== "completed") throw new Error("setup");
  return o.instance;
}

describe("requestUndo", () => {
  it("rolls back when the undo is verified", async () => {
    const h = harness();
    const c = await completed(h);
    const after = await h.orchestrator.requestUndo(personalActor("u1"), c.id);
    expect(after.status).toBe("rolled_back");
    expect(h.repo.trail(c.id).slice(-2)).toEqual(["rolling_back", "rolled_back"]);
  });

  it("fails and notifies when the target changed since", async () => {
    const h = harness([withUndo({ preconditions: async () => [{ id: "unchanged_since", failureCode: "changed_since", passed: false }] })]);
    const c = await completed(h);
    const after = await h.orchestrator.requestUndo(personalActor("u1"), c.id);
    expect(after).toMatchObject({ status: "rollback_failed", error: { code: "changed_since", stage: "undo" } });
    expect(h.notifier.rollbackFailed).toHaveBeenCalledOnce();
  });

  it("fails on a definite undo failure", async () => {
    const h = harness([withUndo({ execute: async () => ({ kind: "definite_failure", code: "not_found", message: "gone" }) })]);
    const after = await h.orchestrator.requestUndo(personalActor("u1"), (await completed(h)).id);
    expect(after).toMatchObject({ status: "rollback_failed", error: { code: "not_found" } });
  });

  it("stays rolling back on an unknown undo outcome", async () => {
    const h = harness([withUndo({ execute: async () => ({ kind: "unknown", code: "timeout", message: "slow" }) })]);
    const c = await completed(h);
    const after = await h.orchestrator.requestUndo(personalActor("u1"), c.id);
    expect(after.status).toBe("rolling_back");
    expect(after.undoStartedAt).not.toBeNull();
  });

  it("refuses irreversible actions", async () => {
    const h = harness([probeDefinition({ rollbackClass: "irreversible", undo: null })]);
    await expect(h.orchestrator.requestUndo(personalActor("u1"), (await completed(h)).id)).rejects.toMatchObject({
      code: "not_allowed",
      message: "This action cannot be automatically reversed.",
    });
  });
});
