import { describe, it, expect, vi } from "vitest";
import { createModelGateway, type ModelGatewayDeps } from "./gateway.js";
import { Fingerprinter } from "./fingerprints.js";
import { InMemoryChoices, InMemoryModelAudit } from "./__tests__/in-memory-audit.js";
import { FakeProvider } from "./__tests__/fake-provider.js";
import { field, personal, record, row, tenant, userMessage } from "./__tests__/builders.js";
import type { ModelContext } from "./types.js";

const silent = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const REPLY = JSON.stringify({ answer: "Done.", usedTools: [] });

function setup(overrides: Partial<ModelGatewayDeps> = {}) {
  const deepseek = new FakeProvider("deepseek", [REPLY]);
  const personalAudit = new InMemoryModelAudit();
  const tenantAudit = new InMemoryModelAudit();
  const gateway = createModelGateway({
    providers: { deepseek },
    overrides: new Map(),
    routing: { standard: "deepseek", reasoning: "deepseek" },
    models: { deepseek: { standard: "flash", reasoning: "pro" } },
    choices: new InMemoryChoices(),
    audit: personalAudit,
    auditFor: (context: ModelContext) => (context.kind === "tenant" ? tenantAudit : personalAudit),
    fingerprinter: new Fingerprinter("k".repeat(32), 1),
    maxRetries: 0,
    timeouts: { standard: 15000, reasoning: 30000 },
    logger: silent,
    clock: () => new Date("2026-10-08T10:00:00.000Z"),
    ...overrides,
  });
  return { gateway, deepseek, personalAudit, tenantAudit };
}

const chat = (parts = [userMessage("what can I do here?")]) => ({ purpose: "chat_reply", output: "json" as const, parts });

describe("gateway in a tenant context", () => {
  it("tenant model-call audit rows land in the tenant file, not personal", async () => {
    const { gateway, personalAudit, tenantAudit } = setup();

    const result = await gateway.beginTurn(tenant).call(chat());

    expect(result).toMatchObject({ kind: "answered" });
    expect(tenantAudit.decisions).toHaveLength(1);
    expect(tenantAudit.decisions[0]).toMatchObject({ contextKind: "tenant", tenantId: "t1", membershipId: "m1", decision: "allow" });
    expect(tenantAudit.outcomes).toHaveLength(1);
    expect(tenantAudit.outcomes[0]).toMatchObject({ callId: tenantAudit.decisions[0].callId, status: "answered" });
    expect(personalAudit.decisions).toEqual([]);
    expect(personalAudit.outcomes).toEqual([]);
  });

  it("a denied tenant call is recorded in the tenant file too", async () => {
    const { gateway, personalAudit, tenantAudit } = setup();

    const result = await gateway.beginTurn(tenant).call({ purpose: "no_such_purpose", output: "json", parts: [userMessage("hi")] });

    expect(result).toMatchObject({ kind: "denied" });
    expect(tenantAudit.decisions).toHaveLength(1);
    expect(personalAudit.decisions).toEqual([]);
  });

  it("a personal call still lands in the personal audit", async () => {
    const { gateway, personalAudit, tenantAudit } = setup();

    await gateway.beginTurn(personal).call(chat());

    expect(personalAudit.decisions).toHaveLength(1);
    expect(personalAudit.outcomes).toHaveLength(1);
    expect(tenantAudit.decisions).toEqual([]);
  });

  it("without auditFor every call goes to the audit given", async () => {
    const { gateway, personalAudit } = setup({ auditFor: undefined });

    await gateway.beginTurn(personal).call(chat());

    expect(personalAudit.decisions).toHaveLength(1);
  });

  describe("tenantLimit", () => {
    const toolData = () => record("tool:show_my_access", [row([field("role", "D1", "Admin"), field("amount", "D2", 4250)])]);

    it("tenantLimit is applied as the tenant layer", async () => {
      const tenantLimit = vi.fn(() => "D1" as const);
      const { gateway, deepseek } = setup({ tenantLimit });

      const result = await gateway.beginTurn(tenant).call(chat([userMessage("show me"), toolData()]));

      expect(tenantLimit).toHaveBeenCalledWith("t1");
      expect(result).toMatchObject({ kind: "answered" });
      expect(result.withheld).toEqual([expect.objectContaining({ part: "record:tool:show_my_access", field: "amount", reason: "above_limit" })]);
      expect(deepseek.calls[0].user).toContain("Admin");
      expect(deepseek.calls[0].user).not.toContain("4250");
    });

    it("is the tenant layer in the audit row and in effectiveLimit", async () => {
      const { gateway, tenantAudit } = setup({ tenantLimit: () => "D0" });

      expect(gateway.beginTurn(tenant).effectiveLimit("chat_reply")).toBe("D0");
      await gateway.beginTurn(tenant).call(chat());

      expect(tenantAudit.decisions[0].effectiveLimit).toBe("D0");
    });

    it("is not consulted for a personal call", async () => {
      const tenantLimit = vi.fn(() => "D0" as const);
      const { gateway } = setup({ tenantLimit });

      await gateway.beginTurn(personal).call(chat());

      expect(tenantLimit).not.toHaveBeenCalled();
    });

    it("defaults to D1", () => {
      const { gateway } = setup();
      expect(gateway.beginTurn(tenant).effectiveLimit("chat_reply")).toBe("D1");
    });
  });
});
