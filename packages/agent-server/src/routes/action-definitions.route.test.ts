import { describe, it, expect, vi } from "vitest";
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

describe("action definitions: config deadlocks", () => {
  it("saves enabled=false over a stored row looser than the floor, dropping the stale value", async () => {
    const t = buildActionsTestApp();
    t.configRepo.save({ scope: "personal", ownerId: "user-A", actionType: "create_calendar_event", configJson: '{"approval":{"mode":"auto"}}', changedBy: "sql" });
    const res = await request(t.app).put("/api/action-definitions/create_calendar_event/config").send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: false, approval: { mode: "above_threshold" }, flags: { clamped: [], rejected: null } });
    expect(JSON.parse(t.configRepo.get("personal", "user-A", "create_calendar_event")!.configJson)).toEqual({ enabled: false });
  });

  it("saves over a stored row that fails the strict schema", async () => {
    const t = buildActionsTestApp();
    t.configRepo.save({ scope: "personal", ownerId: "user-A", actionType: "create_reminder", configJson: '{"bogus":1,"enabled":"yes"}', changedBy: "sql" });
    const res = await request(t.app).put("/api/action-definitions/create_reminder/config").send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: false, flags: { rejected: null } });
    expect(JSON.parse(t.configRepo.get("personal", "user-A", "create_reminder")!.configJson)).toEqual({ enabled: false });
  });

  it("saves over an unparseable stored row", async () => {
    const t = buildActionsTestApp();
    t.configRepo.save({ scope: "personal", ownerId: "user-A", actionType: "create_reminder", configJson: "not json", changedBy: "sql" });
    const res = await request(t.app).put("/api/action-definitions/create_reminder/config").send({ approvalMode: "always" });
    expect(res.status).toBe(200);
    expect(JSON.parse(t.configRepo.get("personal", "user-A", "create_reminder")!.configJson)).toEqual({ approval: { mode: "always" } });
  });
});

describe("action definitions: security and logging", () => {
  it("never touches another user's config or history, and reads only the caller's", async () => {
    const t = buildActionsTestApp();
    await request(t.app).put("/api/action-definitions/create_reminder/config").send({ approvalMode: "auto" });
    const before = t.configRepo.get("personal", "user-A", "create_reminder");
    const bPut = await request(t.app).put("/api/action-definitions/create_reminder/config").set("x-test-user", "user-B").send({ enabled: false });
    expect(bPut.status).toBe(200);
    expect(bPut.body).toMatchObject({ enabled: false, approval: { mode: "always" }, lastChange: { changedBy: "user-B" } });
    expect(t.configRepo.get("personal", "user-A", "create_reminder")).toEqual(before);
    expect(t.configRepo.history("personal", "user-A", "create_reminder", 10)).toHaveLength(1);
    expect(t.configRepo.history("personal", "user-B", "create_reminder", 10)).toHaveLength(1);

    const aList = await request(t.app).get("/api/action-definitions");
    const aDef = aList.body.definitions.find((d: { type: string }) => d.type === "create_reminder");
    expect(aDef).toMatchObject({ enabled: true, approval: { mode: "auto" }, lastChange: { changedBy: "user-A" } });
    const bList = await request(t.app).get("/api/action-definitions").set("x-test-user", "user-B");
    const bDef = bList.body.definitions.find((d: { type: string }) => d.type === "create_reminder");
    expect(bDef).toMatchObject({ enabled: false, lastChange: { changedBy: "user-B" } });
  });

  it("refuses identity and risk fields in the body with 422 and stores nothing", async () => {
    const t = buildActionsTestApp();
    for (const body of [{ ownerId: "user-B" }, { userId: "x" }, { risk: "L0" }]) {
      const res = await request(t.app).put("/api/action-definitions/create_reminder/config").send(body);
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
    expect(t.configRepo.get("personal", "user-A", "create_reminder")).toBeNull();
    expect(t.configRepo.get("personal", "user-B", "create_reminder")).toBeNull();
    expect(t.configRepo.history("personal", "user-A", "create_reminder", 10)).toEqual([]);
  });

  it("logs a warning naming the type and clamped fields when a stored row is clamped on read", async () => {
    const t = buildActionsTestApp();
    t.configRepo.save({ scope: "personal", ownerId: "user-A", actionType: "create_calendar_event", configJson: '{"approval":{"mode":"auto"}}', changedBy: "sql" });
    await request(t.app).get("/api/action-definitions");
    const warn = t.warnings.find((w) => w.context?.actionType === "create_calendar_event");
    expect(warn).toBeDefined();
    expect(warn!.context).toMatchObject({ userId: "user-A", clamped: ["approval.mode"] });
  });

  it("logs a warning when a stored row is rejected on read", async () => {
    const t = buildActionsTestApp();
    t.configRepo.save({ scope: "personal", ownerId: "user-A", actionType: "create_reminder", configJson: "not json", changedBy: "sql" });
    await request(t.app).get("/api/action-definitions");
    expect(t.warnings.find((w) => w.context?.actionType === "create_reminder")!.context).toMatchObject({ rejected: "unparseable" });
  });

  it("returns a generic 500 body that leaks nothing", async () => {
    const t = buildActionsTestApp();
    vi.spyOn(t.configRepo, "get").mockImplementation(() => {
      throw new Error("SQLITE_CORRUPT: secret detail");
    });
    const res = await request(t.app).get("/api/action-definitions");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error" });
  });
});
