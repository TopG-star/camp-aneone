import { describe, it, expect } from "vitest";
import request from "supertest";
import { buildActionsTestApp } from "./__tests__/actions-test-app.js";

describe("action definitions API", () => {
  it("lists every definition with only floor-respecting options", async () => {
    const res = await request(buildActionsTestApp().app).get("/api/action-definitions");
    const byType = Object.fromEntries(res.body.definitions.map((d: { type: string }) => [d.type, d]));
    expect(Object.keys(byType)).toHaveLength(10);
    expect(byType.create_calendar_event.approval.options.map((o: { label: string }) => o.label)).toEqual([
      "Auto unless other people involved",
      "Always ask",
    ]);
    expect(byType.send).toMatchObject({ available: false, unavailableReason: "needs Gmail send access (gmail.send)" });
    expect(byType.notify.disableWarning).toBe("Turning this off stops urgent-email notifications.");
  });

  it("refuses a looser value with 422 and stores nothing", async () => {
    const t = buildActionsTestApp();
    const res = await request(t.app).put("/api/action-definitions/create_calendar_event/config").send({ approvalMode: "auto" });
    expect(res.status).toBe(422);
    expect(res.body.errors[0].field).toBe("approval.mode");
    expect(t.configRepo.get("personal", "user-A", "create_calendar_event")).toBeNull();
  });

  it("saves a valid change, keeps other fields and records who changed it", async () => {
    const t = buildActionsTestApp();
    await request(t.app).put("/api/action-definitions/create_reminder/config").send({ approvalMode: "auto" });
    const res = await request(t.app).put("/api/action-definitions/create_reminder/config").send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ approval: { mode: "auto" }, enabled: false, lastChange: { changedBy: "user-A" } });
    expect(t.configRepo.history("personal", "user-A", "create_reminder", 10)).toHaveLength(2);
  });

  it("refuses config for unavailable actions and unknown types", async () => {
    const t = buildActionsTestApp();
    expect((await request(t.app).put("/api/action-definitions/send/config").send({ enabled: false })).status).toBe(403);
    expect((await request(t.app).put("/api/action-definitions/nope/config").send({ enabled: false })).status).toBe(404);
  });

  it("flags a stored row that is looser than the floor", async () => {
    const t = buildActionsTestApp();
    t.configRepo.save({ scope: "personal", ownerId: "user-A", actionType: "create_calendar_event", configJson: '{"approval":{"mode":"auto"}}', changedBy: "sql" });
    const res = await request(t.app).get("/api/action-definitions");
    const def = res.body.definitions.find((d: { type: string }) => d.type === "create_calendar_event");
    expect(def).toMatchObject({ approval: { mode: "above_threshold" }, flags: { clamped: ["approval.mode"], rejected: null } });
  });
});
