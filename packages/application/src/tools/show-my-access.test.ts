import { describe, it, expect, vi } from "vitest";
import { createShowMyAccessTool } from "./show-my-access.js";
import { createToolRegistry, type TenantToolScope } from "./tool-registry.js";
import { toolResultToRecord } from "./output-schema.js";
import { createActionRegistry } from "../actions/registry.js";
import { InMemoryActionRepo } from "../actions/__tests__/in-memory-repos.js";
import { expectMatchesOutputSchema } from "./__tests__/output-contract.js";

const scope = (overrides: Partial<TenantToolScope> = {}): TenantToolScope => ({
  identityId: "i1",
  tenantId: "t1",
  membershipId: "m1",
  actions: { instanceRepo: new InMemoryActionRepo(() => new Date()), registry: createActionRegistry([]) },
  ...overrides,
});

const membership = {
  identityId: "i1",
  status: "active",
  role: "WarehouseStaff",
  permissions: ["inventory.view", "orders.view"],
  locationIds: ["loc-1", "loc-2"],
  snapshotAt: "2026-10-08T09:00:00.000Z",
};

describe("show_my_access tool", () => {
  it("is available in a tenant context only", () => {
    expect(createShowMyAccessTool({ memberships: { findById: () => membership } }).contexts).toEqual(["tenant"]);
  });

  it("returns the role, permissions, locations and snapshot time of the request's membership", async () => {
    const findById = vi.fn(() => membership);
    const tool = createShowMyAccessTool({ memberships: { findById } });

    const result = await tool.execute(tool.inputSchema.parse({}), scope());

    expect(findById).toHaveBeenCalledWith("m1");
    expect(result.data).toEqual({
      role: "WarehouseStaff",
      permissions: ["inventory.view", "orders.view"],
      locationIds: ["loc-1", "loc-2"],
      snapshotAt: "2026-10-08T09:00:00.000Z",
    });
    expectMatchesOutputSchema(tool, result);
  });

  it("declares every output field D1 and a D1 summary", async () => {
    const tool = createShowMyAccessTool({ memberships: { findById: () => membership } });
    const result = await tool.execute({}, scope());

    const rows = toolResultToRecord(tool.name, tool.output, result).rows;
    expect(rows.flatMap((r) => r.fields).map((f) => [f.name, f.class])).toEqual([
      ["role", "D1"],
      ["permissions", "D1"],
      ["locationIds", "D1"],
      ["snapshotAt", "D1"],
      ["summary", "D1"],
    ]);
  });

  it("takes the membership from the server's scope, never from the model's parameters", async () => {
    const findById = vi.fn(() => membership);
    const tool = createShowMyAccessTool({ memberships: { findById } });

    await tool.execute(tool.inputSchema.parse({ membershipId: "m-other", identityId: "i-other" }), scope());

    expect(findById).toHaveBeenCalledWith("m1");
  });

  it("shows nothing of a membership that belongs to another identity", async () => {
    const tool = createShowMyAccessTool({ memberships: { findById: () => ({ ...membership, identityId: "someone-else" }) } });

    const result = await tool.execute({}, scope());

    expect(result.data).toBeNull();
    expect(result.summary).toBe("Your access to this pharmacy could not be confirmed.");
  });

  it("shows nothing when the membership is no longer active", async () => {
    const tool = createShowMyAccessTool({ memberships: { findById: () => ({ ...membership, status: "suspended" }) } });

    const result = await tool.execute({}, scope());

    expect(result.data).toBeNull();
    expect(result.summary).toBe("Your access to this pharmacy could not be confirmed.");
  });

  it("shows nothing when the membership is gone", async () => {
    const tool = createShowMyAccessTool({ memberships: { findById: () => null } });

    expect((await tool.execute({}, scope())).data).toBeNull();
  });

  it("refuses to run without a tenant scope", () => {
    const tool = createShowMyAccessTool({ memberships: { findById: () => membership } });

    expect(() => tool.execute({})).toThrow("show_my_access needs a tenant context");
  });

  it("runs through the registry in a tenant context and is refused in a personal one", async () => {
    const registry = createToolRegistry();
    registry.register(createShowMyAccessTool({ memberships: { findById: () => membership } }));

    const result = await registry.execute("show_my_access", { userId: "i1", turnId: "t" }, "tenant", scope());

    expect(result).toMatchObject({ data: { role: "WarehouseStaff" }, meta: { toolName: "show_my_access" } });
    expect(await registry.execute("show_my_access", {}, "personal")).toEqual({ ok: false, error: "tool_not_in_context" });
  });
});
