import { describe, it, expect, vi } from "vitest";
import { DelegationRevokedError, DelegationUnreachableError, ExternalCallError, personalActor, tenantActor } from "@oneon/domain";
import { harness, probeDefinition, request } from "../__tests__/orchestrator-harness.js";
import type { PolicyFloor } from "../policy/index.js";
import { impressorxScope } from "./shared.js";
import type { TenantDelegation } from "./types.js";

const HOUR = 3_600_000;
const session = { sessionId: "s1", identityId: "i1" };
const member = { identityId: "i1", tenantId: "t-a", role: "manager", permissions: ["inventory.transfer"], locationIds: [] as string[] };
const actor = tenantActor(member);
const memberships = { activeFor: () => ({ role: "manager", permissions: ["inventory.transfer"], locationIds: [] as string[] }) };

const FLOOR: PolicyFloor = {
  risk: "L1",
  approval: { mode: "always", thresholds: {} },
  requiredPermissions: ["impressorx:inventory.transfer"],
  approverRoles: ["manager"],
  expiryHours: 24,
};
const tenantProbe = (overrides: Parameters<typeof probeDefinition>[0] = {}) =>
  probeDefinition({ scope: "tenant", floor: FLOOR, defaults: { ...FLOOR, enabled: true }, ...overrides });

function delegationStub(overrides: Partial<TenantDelegation> = {}) {
  const calls = { trpc: vi.fn() };
  const delegation = {
    liveApprover: vi.fn(async () => ({ ok: true as const, membership: { role: "manager", permissions: ["inventory.transfer"], locationIds: [] } })),
    issueActionGrant: vi.fn(async () => {}),
    open: vi.fn(async () => calls),
    release: vi.fn(),
    ...overrides,
  } satisfies TenantDelegation;
  return { delegation, calls };
}

async function awaiting(h: ReturnType<typeof harness>) {
  const o = await h.orchestrator.requestAction(request({ actor }));
  if (o.kind === "refused") throw new Error(o.issues.join());
  expect(o.instance.status).toBe("awaiting_approval");
  return o.instance;
}

describe("approving a tenant action", () => {
  it("checks the approver live first and records the approval only after", async () => {
    const trail: string[] = [];
    const { delegation } = delegationStub({
      liveApprover: vi.fn(async () => (trail.push("live"), { ok: true as const, membership: { role: "manager", permissions: ["inventory.transfer"], locationIds: [] } })),
    });
    const h = harness([tenantProbe()], { memberships, delegation });
    const instance = await awaiting(h);
    const originalAppend = h.repo.appendTransition.bind(h.repo);
    h.repo.appendTransition = (r) => (trail.push(r.toStatus), originalAppend(r));

    await h.orchestrator.approve(actor, instance.id, session);

    expect(delegation.liveApprover).toHaveBeenCalledWith(session, "t-a");
    expect(trail.slice(0, 2)).toEqual(["live", "approved"]);
  });

  it("refuses a role that changed since the snapshot, leaving the action awaiting approval", async () => {
    const { delegation } = delegationStub({
      liveApprover: vi.fn(async () => ({ ok: true as const, membership: { role: "viewer", permissions: ["inventory.transfer"], locationIds: [] } })),
    });
    const h = harness([tenantProbe()], { memberships, delegation });
    const instance = await awaiting(h);
    const events = h.repo.events.length;

    await expect(h.orchestrator.approve(actor, instance.id, session)).rejects.toMatchObject({ code: "not_allowed" });

    expect(h.repo.findById("t-a", instance.id)!.status).toBe("awaiting_approval");
    expect(h.repo.events).toHaveLength(events);
    expect(delegation.issueActionGrant).not.toHaveBeenCalled();
  });

  it("judges the decision on the live permissions, not the snapshot's", async () => {
    const { delegation } = delegationStub({
      liveApprover: vi.fn(async () => ({ ok: true as const, membership: { role: "manager", permissions: [], locationIds: [] } })),
    });
    const h = harness([tenantProbe()], { memberships, delegation });
    const instance = await awaiting(h);

    const result = await h.orchestrator.approve(actor, instance.id, session);

    expect(result.status).toBe("rejected"); // the live role lost inventory.transfer: policy refuses
    expect(delegation.issueActionGrant).not.toHaveBeenCalled();
  });

  it.each(["membership_suspended", "launch_required", "impressorx_unreachable"] as const)(
    "a live check that answers %s records nothing and changes nothing",
    async (reason) => {
      const { delegation } = delegationStub({ liveApprover: vi.fn(async () => ({ ok: false as const, refusal: reason })) });
      const h = harness([tenantProbe()], { memberships, delegation });
      const instance = await awaiting(h);
      const events = h.repo.events.length;

      await expect(h.orchestrator.approve(actor, instance.id, session)).rejects.toEqual(expect.objectContaining({ name: "ApprovalCheckError", reason }));

      expect(h.repo.findById("t-a", instance.id)!.status).toBe("awaiting_approval");
      expect(h.repo.events).toHaveLength(events);
      expect(delegation.issueActionGrant).not.toHaveBeenCalled();
    },
  );

  it("fails closed when no delegation is configured", async () => {
    const h = harness([tenantProbe()], { memberships });
    const instance = await awaiting(h);

    await expect(h.orchestrator.approve(actor, instance.id, session)).rejects.toEqual(expect.objectContaining({ name: "ApprovalCheckError", reason: "launch_required" }));
    expect(h.repo.findById("t-a", instance.id)!.status).toBe("awaiting_approval");
  });

  it("issues an action-bound grant scoped to the permissions, expiring at the approval age limit", async () => {
    const { delegation } = delegationStub({ open: vi.fn(async () => { throw new DelegationUnreachableError(); }) });
    const h = harness([tenantProbe()], { memberships, delegation });
    const instance = await awaiting(h);

    const approved = await h.orchestrator.approve(actor, instance.id, session);

    const approvedAt = h.repo.approvedAt(instance.id)!;
    expect(delegation.issueActionGrant).toHaveBeenCalledWith({
      instance: expect.objectContaining({ id: instance.id }),
      session,
      scope: ["inventory.transfer"],
      absoluteExpiresAt: new Date(Date.parse(approvedAt) + 24 * HOUR).toISOString(),
    });
    expect(approved.status).toBe("approved");
  });

  it("uses the configured lower limit for the grant's expiry", async () => {
    const { delegation } = delegationStub({ open: vi.fn(async () => { throw new DelegationUnreachableError(); }) });
    const h = harness([tenantProbe()], { memberships, delegation });
    h.configRepo.save({ scope: "tenant", ownerId: "t-a", actionType: "probe", configJson: JSON.stringify({ maxApprovalAgeHours: 6 }), changedBy: "i1" });
    const instance = await awaiting(h);

    await h.orchestrator.approve(actor, instance.id, session);

    expect(delegation.issueActionGrant).toHaveBeenCalledWith(
      expect.objectContaining({ absoluteExpiresAt: new Date(Date.parse(h.repo.approvedAt(instance.id)!) + 6 * HOUR).toISOString() }),
    );
  });

  it("executes in the request through the attended session, even when issuing the grant did nothing", async () => {
    const { delegation, calls } = delegationStub({ issueActionGrant: vi.fn(async () => {}) });
    const seen: unknown[] = [];
    const h = harness([tenantProbe({ execute: async (ctx) => (seen.push(ctx.impressorx), { kind: "succeeded", result: {}, undoData: null }) })], {
      memberships,
      delegation,
    });
    const instance = await awaiting(h);

    const done = await h.orchestrator.approve(actor, instance.id, session);

    expect(done.status).toBe("completed");
    expect(delegation.open).toHaveBeenCalledWith(expect.objectContaining({ id: instance.id }), session);
    expect(seen).toEqual([calls]);
  });

  it("an action that ended while its grant was being issued has the grant released again once the issue returns", async () => {
    const trail: string[] = [];
    const holder: { cancel?: () => Promise<unknown> } = {};
    const { delegation } = delegationStub({
      issueActionGrant: vi.fn(async () => {
        trail.push("issue starts");
        await holder.cancel!(); // another request cancels the action while ImpressoRx is being asked
        trail.push("issue returns");
      }),
      release: vi.fn((i) => void trail.push(`release ${i.status}`)),
    });
    const h = harness([tenantProbe()], { memberships, delegation });
    const instance = await awaiting(h);
    holder.cancel = () => h.orchestrator.cancel(actor, instance.id);

    const result = await h.orchestrator.approve(actor, instance.id, session);

    expect(result.status).toBe("cancelled");
    // The cancel released nothing (the grant did not exist yet); the release after the issue returns is the one that revokes it.
    expect(trail).toEqual(["issue starts", "release cancelled", "issue returns", "release cancelled"]);
  });

  it("does not release again after an issue when the action is still running", async () => {
    const { delegation } = delegationStub({ open: vi.fn(async () => { throw new DelegationUnreachableError(); }) });
    const h = harness([tenantProbe()], { memberships, delegation });
    const instance = await awaiting(h);

    await h.orchestrator.approve(actor, instance.id, session);

    expect(delegation.release).not.toHaveBeenCalled();
  });

  it("only permissions that are ImpressoRx's go into the grant's scope", () => {
    expect(impressorxScope(["impressorx:inventory.transfer", "calendar.write", "impressorx:customers.view"])).toEqual([
      "inventory.transfer",
      "customers.view",
    ]);
    expect(impressorxScope(["calendar.write"])).toEqual([]);
  });

  it("the sweeper opens the connection without a session", async () => {
    const { delegation } = delegationStub({ open: vi.fn(async () => { throw new DelegationUnreachableError(); }) });
    const h = harness([tenantProbe()], { memberships, delegation });
    const instance = await awaiting(h);
    await h.orchestrator.approve(actor, instance.id, session);
    h.advanceClock(10 * 60_000);

    await h.orchestrator.sweep("t-a");

    expect(delegation.open).toHaveBeenLastCalledWith(expect.objectContaining({ id: instance.id }), undefined);
  });

  it("rejecting needs no live check and a personal action never uses the delegation", async () => {
    const { delegation } = delegationStub();
    const h = harness([tenantProbe(), probeDefinition({ type: "mine", defaults: { ...probeDefinition().defaults, approval: { mode: "always", thresholds: {} } } })], {
      memberships,
      delegation,
    });
    const instance = await awaiting(h);
    expect((await h.orchestrator.reject(actor, instance.id)).status).toBe("rejected");

    const mine = await h.orchestrator.requestAction(request({ type: "mine", actor: personalActor("u1") }));
    if (mine.kind === "refused") throw new Error();
    expect(mine.instance.status).toBe("awaiting_approval");
    expect((await h.orchestrator.approve(personalActor("u1"), mine.instance.id)).status).toBe("completed");
    expect(delegation.liveApprover).not.toHaveBeenCalled();
    expect(delegation.open).not.toHaveBeenCalled();
    expect(delegation.issueActionGrant).not.toHaveBeenCalled();
  });
});

describe("execution failure mapping", () => {
  const auto = { floor: { ...FLOOR, approval: { mode: "auto" as const, thresholds: {} } }, defaults: { ...FLOOR, approval: { mode: "auto" as const, thresholds: {} }, enabled: true } };
  const run = async (delegationOverrides: Partial<TenantDelegation>, def: Parameters<typeof probeDefinition>[0] = {}) => {
    const stub = delegationStub(delegationOverrides);
    const h = harness([tenantProbe({ ...auto, ...def })], { memberships, delegation: stub.delegation });
    const o = await h.orchestrator.requestAction(request({ actor, session }));
    if (o.kind === "refused") throw new Error(o.issues.join());
    return { ...stub, h, instance: o.instance };
  };

  it("a revoked delegation before the executor runs fails the action as delegation_revoked", async () => {
    const r = await run({ open: vi.fn(async () => { throw new DelegationRevokedError(); }) });
    expect(r.instance).toMatchObject({ status: "failed", error: { code: "delegation_revoked", stage: "recheck" } });
  });

  it("another failure to open a connection fails the action once, without retrying", async () => {
    const r = await run({ open: vi.fn(async () => { throw new ExternalCallError("definite", "impressorx_refused", "ImpressoRx answered 404"); }) });
    expect(r.instance).toMatchObject({ status: "failed", error: { code: "impressorx_refused", stage: "recheck" } });
    r.h.advanceClock(HOUR);
    await r.h.orchestrator.sweep("t-a");
    expect(r.delegation.open).toHaveBeenCalledTimes(1);
  });

  it("an unexpected error while opening leaves the action approved for the sweeper", async () => {
    const r = await run({ open: vi.fn(async () => { throw new Error("database is locked"); }) });
    expect(r.instance.status).toBe("approved");
  });

  it("a permanent refusal inside the executor (a tRPC FORBIDDEN) takes the existing non-retried path", async () => {
    const r = await run({}, { execute: async () => { throw new ExternalCallError("definite", "impressorx_refused", "ImpressoRx answered 403"); } });
    expect(r.instance).toMatchObject({ status: "failed", error: { code: "impressorx_refused", stage: "execution" } });
    r.h.advanceClock(25 * HOUR);
    await r.h.orchestrator.sweep("t-a");
    expect(r.h.repo.findById("t-a", r.instance.id)).toMatchObject({ status: "failed", error: { code: "impressorx_refused" } }); // never became approval_stale
    expect(r.delegation.open).toHaveBeenCalledTimes(1);
  });

  it("a delegation revoked while the executor runs fails the action as delegation_revoked", async () => {
    const r = await run({}, { execute: async () => { throw new DelegationRevokedError(); } });
    expect(r.instance).toMatchObject({ status: "failed", error: { code: "delegation_revoked" } });
  });

  it("an unreachable ImpressoRx while the executor runs is an unknown outcome and goes to verification", async () => {
    const r = await run({}, { execute: async () => { throw new DelegationUnreachableError(); } });
    expect(r.instance).toMatchObject({ status: "completed" }); // the probe verifies the effect: it is there
    const trail = r.h.repo.trail(r.instance.id);
    expect(trail).toEqual(expect.arrayContaining(["executing", "verifying"]));
    expect(r.h.repo.events.find((e) => e.toStatus === "verifying")!.data).toMatchObject({ outcome: "unknown", code: "impressorx_unreachable" });
  });

  it("an executor without a delegation (none configured) fails a tenant action as delegation_revoked", async () => {
    const h = harness([tenantProbe({ ...auto })], { memberships });
    const o = await h.orchestrator.requestAction(request({ actor }));
    if (o.kind === "refused") throw new Error();
    expect(o.instance).toMatchObject({ status: "failed", error: { code: "delegation_revoked" } });
  });
});

describe("the grant dies with the action (spec 7.1)", () => {
  const released = (delegation: TenantDelegation) => (delegation.release as ReturnType<typeof vi.fn>).mock.calls.map(([i]) => i.status);

  it.each([
    ["completed", async (h: ReturnType<typeof harness>, id: string) => (await h.orchestrator.approve(actor, id, session)).status],
    ["rejected", async (h: ReturnType<typeof harness>, id: string) => (await h.orchestrator.reject(actor, id)).status],
    ["cancelled", async (h: ReturnType<typeof harness>, id: string) => (await h.orchestrator.cancel(actor, id)).status],
  ])("releases it on %s", async (status, act) => {
    const { delegation } = delegationStub();
    const h = harness([tenantProbe()], { memberships, delegation });
    const instance = await awaiting(h);
    expect(delegation.release).not.toHaveBeenCalled(); // awaiting approval is not final

    expect(await act(h, instance.id)).toBe(status);

    expect(released(delegation)).toContain(status);
  });

  it("releases it on expired and on failed, and not on the way there", async () => {
    const { delegation } = delegationStub();
    const h = harness([tenantProbe()], { memberships, delegation });
    const instance = await awaiting(h);
    h.advanceClock(25 * HOUR);
    await h.orchestrator.expireStale("t-a");
    expect(released(delegation)).toEqual(["expired"]);

    const failing = delegationStub({ open: vi.fn(async () => { throw new DelegationRevokedError(); }) });
    const h2 = harness([tenantProbe()], { memberships, delegation: failing.delegation });
    const second = await awaiting(h2);
    await h2.orchestrator.approve(actor, second.id, session);
    expect(released(failing.delegation)).toEqual(["failed"]);
    void instance;
  });

  it("never releases anything for a personal action", async () => {
    const { delegation } = delegationStub();
    const h = harness([probeDefinition()], { delegation });
    await h.orchestrator.requestAction(request());
    expect(delegation.release).not.toHaveBeenCalled();
  });

  it("a failing release does not undo the transition", async () => {
    const { delegation } = delegationStub({ release: vi.fn(() => { throw new Error("control database is locked"); }) });
    const h = harness([tenantProbe()], { memberships, delegation });
    const instance = await awaiting(h);

    await expect(h.orchestrator.cancel(actor, instance.id)).resolves.toMatchObject({ status: "cancelled" });
    expect(h.repo.findById("t-a", instance.id)!.status).toBe("cancelled");
  });
});

