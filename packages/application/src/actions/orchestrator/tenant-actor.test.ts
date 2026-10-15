import { describe, it, expect } from "vitest";
import { tenantActor, type ActorContext } from "@oneon/domain";
import { harness, probeDefinition, request } from "../__tests__/orchestrator-harness.js";
import { canApprove } from "../policy/index.js";
import { actorForInstance } from "./shared.js";

const member = { identityId: "i1", tenantId: "t-a", role: "manager", permissions: ["inventory.view"], locationIds: ["l1"] };

describe("tenantActor", () => {
  it("namespaces permissions", () => {
    expect(tenantActor(member)).toEqual({
      userId: "i1",
      scope: "tenant",
      tenantId: "t-a",
      roles: ["manager"],
      permissions: ["impressorx:inventory.view"],
      locationIds: ["l1"],
    });
  });
});

const tenantInstance = { scope: "tenant", userId: "i1", tenantId: "t-a", ownerId: "t-a" } as never;

describe("actorForInstance", () => {
  it("rebuilds a tenant actor from the current membership", () => {
    const seen: Array<[string, string]> = [];
    const actor = actorForInstance(tenantInstance, {
      activeFor: (identityId, tenantId) => {
        seen.push([identityId, tenantId]);
        return { role: "owner", permissions: ["a.b"], locationIds: ["l9"] };
      },
    });
    expect(seen).toEqual([["i1", "t-a"]]);
    expect(actor).toEqual(tenantActor({ identityId: "i1", tenantId: "t-a", role: "owner", permissions: ["a.b"], locationIds: ["l9"] }));
  });

  it("throws delegation_revoked when no membership is active", () => {
    expect(() => actorForInstance(tenantInstance, { activeFor: () => null })).toThrowError(
      expect.objectContaining({ name: "DelegationRevokedError" }),
    );
  });
});

describe("tenant actions in the orchestrator", () => {
  const tenantProbe = () => probeDefinition({ scope: "tenant" });

  it("fails with delegation_revoked when the membership is suspended", async () => {
    const h = harness([tenantProbe()], { memberships: { activeFor: () => null } });
    const outcome = await h.orchestrator.requestAction(request({ actor: tenantActor(member) }));
    if (outcome.kind === "refused") throw new Error(outcome.issues.join());
    expect(outcome.instance.status).toBe("failed");
    expect(outcome.instance.error).toEqual({
      code: "delegation_revoked",
      message: "The person's access to this pharmacy has ended.",
      stage: "recheck",
    });
  });

  it("runs as the current membership, not the one at request time", async () => {
    const actors: ActorContext[] = [];
    const def = probeDefinition({ scope: "tenant", preconditions: async (ctx) => (actors.push(ctx.actor), []) });
    const h = harness([def], { memberships: { activeFor: () => ({ role: "owner", permissions: ["now.held"], locationIds: [] }) } });
    await h.orchestrator.requestAction(request({ actor: tenantActor({ ...member, permissions: [] }) }));
    expect(actors[0]?.permissions).toEqual(["impressorx:now.held"]);
  });

  it("does not let an actor from tenant B approve tenant A's action", async () => {
    const h = harness([tenantProbe()], { memberships: { activeFor: () => ({ role: "manager", permissions: [], locationIds: [] }) } });
    const outcome = await h.orchestrator.requestAction(request({ actor: tenantActor(member) }));
    if (outcome.kind === "refused") throw new Error(outcome.issues.join());
    const policy = { approverRoles: ["manager"] } as never;
    expect(canApprove(tenantActor(member), outcome.instance, policy)).toBe(true);
    expect(canApprove(tenantActor({ ...member, tenantId: "t-b" }), outcome.instance, policy)).toBe(false);
  });
});
