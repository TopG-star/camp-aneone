import { describe, it, expect, vi } from "vitest";
import { DelegationUnreachableError, tenantActor } from "@oneon/domain";
import { harness, probeDefinition, request } from "../__tests__/orchestrator-harness.js";
import { clampPolicy, validateConfigWrite, type EffectivePolicy, type PolicyFloor } from "../policy/index.js";
import { createActionRegistry } from "../registry.js";
import type { TenantDelegation } from "./types.js";

const HOUR = 3_600_000;
const MIN = 60_000;

const member = { identityId: "i1", tenantId: "t-a", role: "manager", permissions: ["inventory.transfer"], locationIds: [] as string[] };
const actor = tenantActor(member);
const memberships = { activeFor: () => ({ role: "manager", permissions: ["inventory.transfer"], locationIds: [] as string[] }) };

const FLOOR: PolicyFloor = {
  risk: "L1",
  approval: { mode: "auto", thresholds: {} },
  requiredPermissions: ["impressorx:inventory.transfer"],
  approverRoles: ["manager"],
  expiryHours: 24,
};
const tenantProbe = (overrides: Parameters<typeof probeDefinition>[0] = {}) =>
  probeDefinition({ scope: "tenant", floor: FLOOR, defaults: { ...FLOOR, enabled: true }, ...overrides });

function delegationStub(overrides: Partial<TenantDelegation> = {}) {
  const calls = { trpc: vi.fn() };
  const delegation: TenantDelegation = {
    liveApprover: vi.fn(async () => ({ ok: true as const, membership: { role: "manager", permissions: ["inventory.transfer"], locationIds: [] } })),
    issueActionGrant: vi.fn(async () => {}),
    open: vi.fn(async () => calls),
    release: vi.fn(),
    ...overrides,
  };
  return { delegation, calls };
}

describe("maxApprovalAgeHours (spec 7.6)", () => {
  const defaults: EffectivePolicy = { ...FLOOR, maxApprovalAgeHours: 24, enabled: true };
  const base = { floor: { ...FLOOR, maxApprovalAgeHours: 24 }, defaults, declaredMetrics: [], executorAvailable: true };

  it("configuration may lower maxApprovalAgeHours but not raise it", () => {
    const raised = clampPolicy({ ...base, storedJson: JSON.stringify({ maxApprovalAgeHours: 48 }) });
    expect(raised.policy.maxApprovalAgeHours).toBe(24);
    expect(raised.clamped).toContain("maxApprovalAgeHours");

    const lowered = clampPolicy({ ...base, storedJson: JSON.stringify({ maxApprovalAgeHours: 6 }) });
    expect(lowered.policy.maxApprovalAgeHours).toBe(6);
    expect(lowered.clamped).toEqual([]);
  });

  it("a configuration write above the floor is refused, one below is stored", () => {
    const write = (maxApprovalAgeHours: number) => validateConfigWrite({ floor: base.floor, declaredMetrics: [], body: { maxApprovalAgeHours } });
    expect(write(48)).toEqual({ ok: false, errors: [{ field: "maxApprovalAgeHours", message: expect.stringContaining("24") }] });
    expect(write(6)).toMatchObject({ ok: true });
  });

  it("an action without the field has no age limit in its policy (personal definitions)", () => {
    const personal = clampPolicy({ floor: FLOOR, defaults: { ...FLOOR, enabled: true }, storedJson: null, declaredMetrics: [], executorAvailable: true });
    expect(personal.policy).not.toHaveProperty("maxApprovalAgeHours");
  });

  it("the registry gives every tenant definition the floor of 24 hours and refuses a larger one", () => {
    const registered = createActionRegistry([tenantProbe()]).get("probe");
    expect(registered.floor.maxApprovalAgeHours).toBe(24);
    expect(createActionRegistry([tenantProbe({ floor: { ...FLOOR, maxApprovalAgeHours: 6 } })]).get("probe").floor.maxApprovalAgeHours).toBe(6);
    expect(() => createActionRegistry([tenantProbe({ floor: { ...FLOOR, maxApprovalAgeHours: 48 } })])).toThrow("maxApprovalAgeHours");
    expect(createActionRegistry([probeDefinition()]).get("probe").floor).not.toHaveProperty("maxApprovalAgeHours");
  });
});

describe("the approval age limit at execution", () => {
  /** An approved tenant action that ImpressoRx could not be reached for, so it waits for the sweeper. */
  async function waiting(opts: { config?: object } = {}) {
    let reachable = false;
    const { delegation, calls } = delegationStub({
      open: vi.fn(async () => {
        if (!reachable) throw new DelegationUnreachableError();
        return calls;
      }),
    });
    const executed = vi.fn();
    const h = harness([tenantProbe({ execute: async (ctx) => (executed(ctx.impressorx), { kind: "succeeded", result: {}, undoData: null }) })], {
      memberships,
      delegation,
    });
    if (opts.config) h.configRepo.save({ scope: "tenant", ownerId: "t-a", actionType: "probe", configJson: JSON.stringify(opts.config), changedBy: "i1" });
    const o = await h.orchestrator.requestAction(request({ actor }));
    if (o.kind === "refused") throw new Error(o.issues.join());
    expect(o.instance.status).toBe("approved");
    return { h, id: o.instance.id, delegation, executed, reconnect: () => (reachable = true) };
  }

  it("an approval older than 24 hours fails as approval_stale", async () => {
    const w = await waiting();
    w.h.advanceClock(25 * HOUR);

    await w.h.orchestrator.sweep("t-a");

    expect(w.h.repo.findById("t-a", w.id)).toMatchObject({
      status: "failed",
      error: { code: "approval_stale", message: "This approval is too old to act on. Ask for it again.", stage: "recheck" },
    });
    expect(w.executed).not.toHaveBeenCalled();
    expect(w.delegation.open).toHaveBeenCalledTimes(1); // the age check comes before anything is asked of ImpressoRx
  });

  it("a 23-hour approval proceeds", async () => {
    const w = await waiting();
    w.h.advanceClock(23 * HOUR);
    w.reconnect();

    await w.h.orchestrator.sweep("t-a");

    expect(w.h.repo.findById("t-a", w.id)!.status).toBe("completed");
    expect(w.executed).toHaveBeenCalledTimes(1);
  });

  it("measures the age from the approval event, not from later retry events", async () => {
    const w = await waiting();
    for (let i = 0; i < 4; i++) {
      w.h.advanceClock(7 * HOUR); // each sweep adds a retry event; none of them restarts the clock
      await w.h.orchestrator.sweep("t-a");
    }
    expect(w.h.repo.findById("t-a", w.id)).toMatchObject({ status: "failed", error: { code: "approval_stale" } });
  });

  it("the age limit does not depend on the approval window: a tenant approval is failed as stale, never cancelled by the older stale-approval rule", async () => {
    const w = await waiting();
    w.h.advanceClock(30 * HOUR);

    await w.h.orchestrator.sweep("t-a");

    expect(w.h.repo.findById("t-a", w.id)!.status).toBe("failed");
  });

  it("a configured lower limit applies", async () => {
    const w = await waiting({ config: { maxApprovalAgeHours: 6 } });
    w.h.advanceClock(7 * HOUR);

    await w.h.orchestrator.sweep("t-a");

    expect(w.h.repo.findById("t-a", w.id)).toMatchObject({ status: "failed", error: { code: "approval_stale" } });
  });

  it("the age check uses the limit recorded with the approval, so raising the configured limit afterwards cannot revive it", async () => {
    const always = { mode: "always" as const, thresholds: {} };
    const { delegation } = delegationStub({ open: vi.fn(async () => { throw new DelegationUnreachableError(); }) });
    const h = harness([tenantProbe({ floor: { ...FLOOR, approval: always }, defaults: { ...FLOOR, approval: always, enabled: true } })], { memberships, delegation });
    h.configRepo.save({ scope: "tenant", ownerId: "t-a", actionType: "probe", configJson: JSON.stringify({ maxApprovalAgeHours: 6 }), changedBy: "i1" });
    const proposed = await h.orchestrator.requestAction(request({ actor }));
    if (proposed.kind === "refused") throw new Error();
    await h.orchestrator.approve(actor, proposed.instance.id, { sessionId: "s1", identityId: "i1" }); // approved under 6 hours; ImpressoRx is unreachable
    expect(h.repo.findById("t-a", proposed.instance.id)!.status).toBe("approved");

    h.configRepo.save({ scope: "tenant", ownerId: "t-a", actionType: "probe", configJson: JSON.stringify({ maxApprovalAgeHours: 24 }), changedBy: "i1" });
    h.advanceClock(7 * HOUR);
    await h.orchestrator.sweep("t-a");

    expect(h.repo.findById("t-a", proposed.instance.id)).toMatchObject({ status: "failed", error: { code: "approval_stale" } });
  });

  it("lowering the configured limit after the approval takes effect at once: the shorter of the recorded and the current limit applies", async () => {
    const always = { mode: "always" as const, thresholds: {} };
    const { delegation } = delegationStub({ open: vi.fn(async () => { throw new DelegationUnreachableError(); }) });
    const h = harness([tenantProbe({ floor: { ...FLOOR, approval: always }, defaults: { ...FLOOR, approval: always, enabled: true } })], { memberships, delegation });
    const proposed = await h.orchestrator.requestAction(request({ actor }));
    if (proposed.kind === "refused") throw new Error();
    await h.orchestrator.approve(actor, proposed.instance.id, { sessionId: "s1", identityId: "i1" }); // approved under the default 24 hours; ImpressoRx is unreachable
    expect(h.repo.findById("t-a", proposed.instance.id)!.status).toBe("approved");

    h.advanceClock(5 * HOUR);
    await h.orchestrator.sweep("t-a");
    expect(h.repo.findById("t-a", proposed.instance.id)!.status).toBe("approved"); // still inside both limits

    h.configRepo.save({ scope: "tenant", ownerId: "t-a", actionType: "probe", configJson: JSON.stringify({ maxApprovalAgeHours: 6 }), changedBy: "i1" });
    h.advanceClock(2 * HOUR);
    await h.orchestrator.sweep("t-a");

    expect(h.repo.findById("t-a", proposed.instance.id)).toMatchObject({ status: "failed", error: { code: "approval_stale" } });
  });

  it("a personal action keeps its own stale-approval rule and gets no age limit", async () => {
    let checks = 0;
    const h = harness([probeDefinition({ preconditions: async () => { if (++checks > 1) throw new Error("down at the re-check"); return []; } })]);
    const o = await h.orchestrator.requestAction(request());
    if (o.kind === "refused") throw new Error();
    expect(o.instance.status).toBe("approved");

    h.advanceClock(30 * HOUR);
    await h.orchestrator.sweep("u1");

    expect(h.repo.findById("u1", o.instance.id)).toMatchObject({ status: "cancelled", error: null });
    expect(h.repo.events.at(-1)!.data).toEqual({ reason: "stale_approval" });
  });
});

describe("an unreachable ImpressoRx keeps the action approved", () => {
  it("records a retry event, retries on the sweeper, then approval_stale after the limit", async () => {
    let reachable = false;
    const { delegation, calls } = delegationStub({
      open: vi.fn(async () => {
        if (!reachable) throw new DelegationUnreachableError();
        return calls;
      }),
    });
    const h = harness([tenantProbe()], { memberships, delegation });
    const o = await h.orchestrator.requestAction(request({ actor }));
    if (o.kind === "refused") throw new Error();
    const id = o.instance.id;

    expect(o.instance.status).toBe("approved");
    const notes = () => h.repo.events.filter((e) => e.actionId === id && e.fromStatus === e.toStatus);
    expect(notes()).toHaveLength(1);
    expect(notes()[0]).toMatchObject({ toStatus: "approved", actor: { kind: "system" }, data: { retry: "impressorx_unreachable" } });

    h.advanceClock(10 * MIN);
    await h.orchestrator.sweep("t-a");
    expect(h.repo.findById("t-a", id)!.status).toBe("approved");
    expect(delegation.open).toHaveBeenCalledTimes(2);
    expect(notes()).toHaveLength(2);

    h.advanceClock(HOUR);
    await h.orchestrator.sweep("t-a");
    expect(delegation.open).toHaveBeenCalledTimes(3);

    h.advanceClock(24 * HOUR);
    await h.orchestrator.sweep("t-a");
    expect(h.repo.findById("t-a", id)).toMatchObject({ status: "failed", error: { code: "approval_stale" } });
    expect(delegation.open).toHaveBeenCalledTimes(3);
  });

  it("does not retry again before the recovery threshold has passed since the last attempt", async () => {
    const { delegation } = delegationStub({ open: vi.fn(async () => { throw new DelegationUnreachableError(); }) });
    const h = harness([tenantProbe()], { memberships, delegation });
    await h.orchestrator.requestAction(request({ actor }));

    h.advanceClock(30_000);
    expect(await h.orchestrator.sweep("t-a")).toEqual({ recovered: 0 });
    h.advanceClock(2 * MIN);
    await h.orchestrator.sweep("t-a");
    expect(delegation.open).toHaveBeenCalledTimes(2);

    h.advanceClock(30_000); // the second attempt was 30 s ago
    expect(await h.orchestrator.sweep("t-a")).toEqual({ recovered: 0 });
    expect(delegation.open).toHaveBeenCalledTimes(2);
  });

  it("the approval event is the first approved event, so a retry event cannot reset the age", async () => {
    const { delegation } = delegationStub({ open: vi.fn(async () => { throw new DelegationUnreachableError(); }) });
    const h = harness([tenantProbe()], { memberships, delegation });
    const o = await h.orchestrator.requestAction(request({ actor }));
    if (o.kind === "refused") throw new Error();
    const approvedAt = h.repo.approvedAt(o.instance.id);
    h.advanceClock(HOUR);
    await h.orchestrator.sweep("t-a");
    expect(h.repo.approvedAt(o.instance.id)).toBe(approvedAt);
  });
});
