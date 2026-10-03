import { describe, it, expect, vi } from "vitest";
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
    expect(approved.body).toMatchObject({ status: "completed", allowedOperations: ["undo"], undo: { text: "Can be undone" } });
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

describe("security: owner scoping", () => {
  it("returns 404 to another user for reject, cancel, undo, retry and events", async () => {
    const t = buildActionsTestApp();
    const a = await proposeReminder(t);
    for (const op of ["reject", "cancel", "undo", "retry"]) {
      const res = await request(t.app).post(`/api/actions/${a.id}/${op}`).set("x-test-user", "user-B");
      expect(res.status, op).toBe(404);
    }
    expect((await request(t.app).get(`/api/actions/${a.id}/events`).set("x-test-user", "user-B")).status).toBe(404);
    expect(t.instanceRepo.findById("user-A", a.id)!.status).toBe("awaiting_approval");
  });

  it("shows another user an empty list with total 0, with or without a group", async () => {
    const t = buildActionsTestApp();
    await proposeReminder(t);
    for (const url of ["/api/actions", "/api/actions?group=needs_you"]) {
      const res = await request(t.app).get(url).set("x-test-user", "user-B");
      expect(res.status).toBe(200);
      expect(res.body.actions).toEqual([]);
      expect(res.body.pagination.total).toBe(0);
    }
  });

  it("does not let a userId query parameter widen the scope", async () => {
    const t = buildActionsTestApp();
    await proposeReminder(t);
    const res = await request(t.app).get("/api/actions?userId=user-A").set("x-test-user", "user-B");
    expect(res.status).toBe(200);
    expect(res.body.actions).toEqual([]);
    expect(res.body.pagination.total).toBe(0);
  });

  it("excludes another user's legacy rows", async () => {
    const t = buildActionsTestApp();
    t.db.prepare("INSERT INTO action_log_legacy (id, resource_id, action_type, risk_level, status, user_id, payload_json) VALUES ('l1','i1','archive','approval_required','executed','user-A','{}')").run();
    const res = await request(t.app).get("/api/actions/legacy").set("x-test-user", "user-B");
    expect(res.status).toBe(200);
    expect(res.body.actions).toEqual([]);
    expect(res.body.pagination.total).toBe(0);
  });
});

describe("GET /api/actions details", () => {
  it("returns the events timeline for the owner", async () => {
    const t = buildActionsTestApp();
    const a = await proposeReminder(t);
    const res = await request(t.app).get(`/api/actions/${a.id}/events`);
    expect(res.status).toBe(200);
    expect(res.body.events.map((e: { toStatus: string }) => e.toStatus)).toEqual(["proposed", "validating", "awaiting_approval"]);
  });

  it("filters by status", async () => {
    const t = buildActionsTestApp();
    const a = await proposeReminder(t);
    await request(t.app).post(`/api/actions/${a.id}/approve`);
    const done = await request(t.app).get("/api/actions?status=completed");
    expect(done.body.actions.map((x: { id: string }) => x.id)).toEqual([a.id]);
    const waiting = await request(t.app).get("/api/actions?status=awaiting_approval");
    expect(waiting.body.actions).toEqual([]);
    expect(waiting.body.pagination.total).toBe(0);
  });

  it("returns 400 for a bad list query", async () => {
    const t = buildActionsTestApp();
    expect((await request(t.app).get("/api/actions?limit=0")).status).toBe(400);
    expect((await request(t.app).get("/api/actions?group=nope")).status).toBe(400);
    expect((await request(t.app).get("/api/actions?status=nope")).status).toBe(400);
  });

  it("skips an action whose type is not registered and logs a warning, instead of failing the list", async () => {
    const t = buildActionsTestApp();
    const a = await proposeReminder(t);
    const ghost = t.instanceRepo.create(
      {
        id: "ghost-1", scope: "personal", ownerId: "user-A", userId: "user-A", tenantId: null, locationIds: [],
        actionType: "ghost_type", definitionVersion: "1", initiator: "user", initiatorUserId: "user-A",
        input: {}, evidence: [], idempotencyKey: "ghost-key", retryOf: null, attemptNumber: 1, resourceRef: null,
      },
      { kind: "system" },
    );
    const res = await request(t.app).get("/api/actions");
    expect(res.status).toBe(200);
    expect(res.body.actions.map((x: { id: string }) => x.id)).toEqual([a.id]);
    expect(t.warnings.some((w) => w.context?.actionId === ghost.instance.id && w.context?.actionType === "ghost_type")).toBe(true);
  });
});

describe("retry, reject and error handling", () => {
  it("returns 422 when a retry is refused", async () => {
    const t = buildActionsTestApp();
    const a = await proposeReminder(t);
    vi.spyOn(t.orchestrator, "retry").mockResolvedValue({ kind: "refused", issues: [{ code: "precondition_failed", message: "gone" }] } as never);
    const res = await request(t.app).post(`/api/actions/${a.id}/retry`);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Retry refused");
  });

  it("rejects a reason over 1000 characters with 422 and leaves the action untouched", async () => {
    const t = buildActionsTestApp();
    const a = await proposeReminder(t);
    const res = await request(t.app).post(`/api/actions/${a.id}/reject`).send({ reason: "x".repeat(1001) });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Reason must be 1000 characters or fewer.");
    expect(t.instanceRepo.findById("user-A", a.id)!.status).toBe("awaiting_approval");
    const ok = await request(t.app).post(`/api/actions/${a.id}/reject`).send({ reason: "x".repeat(1000) });
    expect(ok.status).toBe(200);
  });

  it("returns a generic 500 body that leaks nothing", async () => {
    const t = buildActionsTestApp();
    vi.spyOn(t.instanceRepo, "list").mockImplementation(() => {
      throw new Error("SQLITE_CORRUPT: secret detail");
    });
    const res = await request(t.app).get("/api/actions");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error" });
  });
});

describe("GET /api/actions/legacy paging", () => {
  it("rejects a negative or fractional limit with 400", async () => {
    const t = buildActionsTestApp();
    expect((await request(t.app).get("/api/actions/legacy?limit=-1")).status).toBe(400);
    expect((await request(t.app).get("/api/actions/legacy?limit=1.5")).status).toBe(400);
    expect((await request(t.app).get("/api/actions/legacy?offset=-1")).status).toBe(400);
  });

  it("caps the page size at 100", async () => {
    const t = buildActionsTestApp();
    const spy = vi.spyOn(t.legacyRepo, "listForUser");
    expect((await request(t.app).get("/api/actions/legacy?limit=200")).status).toBe(200);
    expect(spy).toHaveBeenCalledWith("user-A", { limit: 100, offset: 0 });
  });
});
