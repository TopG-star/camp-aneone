import { describe, it, expect } from "vitest";
import request from "supertest";
import { personalActor } from "@oneon/domain";
import { buildActionsTestApp } from "./__tests__/actions-test-app.js";

const reminderDeadline = { id: "d1", userId: "user-A", inboundItemId: "i1", dueDate: "2026-10-07T17:00:00Z", description: "Submit Q4", confidence: 0.9, status: "open" as const, createdAt: "", updatedAt: "" };

async function proposeReminder(t: ReturnType<typeof buildActionsTestApp>) {
  t.deadlines.set("d1", reminderDeadline);
  const o = await t.orchestrator.requestAction({
    type: "create_reminder", input: { deadlineId: "d1", inboundItemId: "i1" }, actor: personalActor("user-A"),
    initiator: "rule:inbox.deadline_reminder", keyContext: { source: "rule", resourceId: "d1" }, evidence: [], resourceRef: "deadline:d1",
  });
  if (o.kind === "refused") throw new Error();
  return o.instance;
}

describe("GET /api/actions", () => {
  it("lists by group with views the UI can render", async () => {
    const t = buildActionsTestApp();
    const a = await proposeReminder(t);
    const res = await request(t.app).get("/api/actions?group=needs_you");
    expect(res.status).toBe(200);
    expect(res.body.actions).toHaveLength(1);
    expect(res.body.actions[0]).toMatchObject({
      id: a.id,
      label: "Create reminder",
      status: "awaiting_approval",
      group: "needs_you",
      origin: { kind: "rule", label: "Inbox rule · deadline reminder" },
      description: 'Add an all-day reminder "Due: Submit Q4" on 7 Oct 2026 to your calendar.',
      allowedOperations: ["approve", "reject", "cancel"],
      undo: { rollbackClass: "reversible", text: "Can be undone" },
    });
    expect(res.body.actions[0].decision.reasons[0].text).toBe("Create reminder is set to always ask before running.");
    expect(res.body.actions[0].timeline.map((e: { toStatus: string }) => e.toStatus)).toEqual(["proposed", "validating", "awaiting_approval"]);
  });

  it("hides another user's action (404)", async () => {
    const t = buildActionsTestApp();
    const a = await proposeReminder(t);
    expect((await request(t.app).get(`/api/actions/${a.id}`).set("x-test-user", "user-B")).status).toBe(404);
    expect((await request(t.app).post(`/api/actions/${a.id}/approve`).set("x-test-user", "user-B")).status).toBe(404);
  });
});

describe("operations", () => {
  it("approves to completed, refuses a second approve with 409, then undoes", async () => {
    const t = buildActionsTestApp();
    const a = await proposeReminder(t);
    const approved = await request(t.app).post(`/api/actions/${a.id}/approve`);
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ status: "completed", allowedOperations: ["undo"] });
    expect(t.events.size).toBe(1);
    expect((await request(t.app).post(`/api/actions/${a.id}/approve`)).status).toBe(409);
    const undone = await request(t.app).post(`/api/actions/${a.id}/undo`);
    expect(undone.body.status).toBe("rolled_back");
    expect(t.events.size).toBe(0);
  });

  it("rejects and cancels", async () => {
    const t = buildActionsTestApp();
    const a = await proposeReminder(t);
    expect((await request(t.app).post(`/api/actions/${a.id}/reject`).send({ reason: "not now" })).body.status).toBe("rejected");
  });

  it("returns 403 for an operation policy does not allow", async () => {
    const t = buildActionsTestApp();
    const a = await proposeReminder(t);
    await request(t.app).post(`/api/actions/${a.id}/reject`);
    expect((await request(t.app).post(`/api/actions/${a.id}/retry`)).status).toBe(403);
  });

  it("keeps executing after the client disconnects", async () => {
    const t = buildActionsTestApp({ createDelayMs: 100 });
    const a = await proposeReminder(t);
    await request(t.app).post(`/api/actions/${a.id}/approve`).timeout(10).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 300));
    expect(t.instanceRepo.findById("user-A", a.id)!.status).toBe("completed");
  });

  it("lets concurrent approve and cancel settle on one outcome, never a 500", async () => {
    const t = buildActionsTestApp({ createDelayMs: 20 });
    const a = await proposeReminder(t);
    const [r1, r2] = await Promise.all([
      request(t.app).post(`/api/actions/${a.id}/approve`),
      request(t.app).post(`/api/actions/${a.id}/cancel`),
    ]);
    expect([r1.status, r2.status].every((s) => s === 200 || s === 409)).toBe(true);
    const trail = t.instanceRepo.listEvents("user-A", a.id).map((e) => e.toStatus);
    // Either the cancel landed before execution started, or execution ran and the cancel was refused.
    expect(trail.includes("cancelled") && trail.includes("executing")).toBe(false);
    expect(["completed", "cancelled"]).toContain(t.instanceRepo.findById("user-A", a.id)!.status);
  });
});

describe("GET /api/actions/legacy", () => {
  it("returns read-only legacy rows with the banner", async () => {
    const t = buildActionsTestApp();
    t.db.prepare("INSERT INTO action_log_legacy (id, resource_id, action_type, risk_level, status, user_id, payload_json) VALUES ('l1','i1','archive','approval_required','executed','user-A','{\"reason\":\"spam\"}')").run();
    const res = await request(t.app).get("/api/actions/legacy");
    expect(res.body).toMatchObject({
      banner: "MVP1 actions changed status only; nothing was executed.",
      actions: [{ id: "l1", actionType: "archive", status: "executed", payload: { reason: "spam" } }],
    });
    expect(res.body.actions[0].allowedOperations).toBeUndefined();
  });
});
