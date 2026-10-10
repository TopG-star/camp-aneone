import { describe, it, expect, vi } from "vitest";
import { createModelGateway, type ModelGatewayDeps } from "./gateway.js";
import { Fingerprinter } from "./fingerprints.js";
import { InMemoryChoices, InMemoryModelAudit } from "./__tests__/in-memory-audit.js";
import { FakeProvider } from "./__tests__/fake-provider.js";
import { field, personal, record, row, tenant, userMessage } from "./__tests__/builders.js";
import { PROVIDER_REGISTRY, type ProviderEntry } from "./providers.js";
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

  // Spec 9.4: a pharmacy's D2 data goes only to a provider that is reviewed and holds a DPA, whatever the pharmacy's own limit, the
  // provider's registry limit or the routing. This is decided on every call, so it survives a change of routing.
  describe("D2 pharmacy data needs a reviewed provider with a DPA at call time", () => {
    const DPA = { signedOn: "2026-09-30", reference: "DPA-1" };
    const d2Provider = (id: "deepseek" | "anthropic", over: Partial<ProviderEntry> = {}): ProviderEntry => ({
      id,
      label: id,
      limits: { personal: "D2", tenant: "D2" },
      review: "unreviewed",
      ...over,
    });
    const cleared = { review: "reviewed", tenantDpa: DPA } as const;
    const data = () => record("tool:show_my_access", [row([field("role", "D1", "Admin"), field("amount", "D2", 4250)])]);
    const ask = (gateway: ReturnType<typeof setup>["gateway"], context: ModelContext = tenant) => gateway.beginTurn(context).call(chat([userMessage("show me"), data()]));

    it.each([
      ["has no review and no DPA", {}],
      ["is reviewed but has no DPA", { review: "reviewed" }],
      ["has a DPA but is not reviewed", { tenantDpa: DPA }],
    ] as const)("a routed provider that %s receives nothing above D1, although the pharmacy allows D2 and the registry allows it", async (_name, over) => {
      const { gateway, deepseek } = setup({ tenantLimit: () => "D2", registry: { ...PROVIDER_REGISTRY, deepseek: d2Provider("deepseek", over) } });

      const result = await ask(gateway);

      expect(result).toMatchObject({ kind: "answered" });
      expect(result.withheld).toEqual([expect.objectContaining({ part: "record:tool:show_my_access", field: "amount", reason: "above_limit" })]);
      expect(deepseek.calls[0].user).toContain("Admin");
      expect(deepseek.calls[0].user).not.toContain("4250");
      expect(gateway.beginTurn(tenant).effectiveLimit("chat_reply")).toBe("D1");
    });

    it("the same provider, reviewed and with a DPA, receives D2", async () => {
      const { gateway, deepseek } = setup({ tenantLimit: () => "D2", registry: { ...PROVIDER_REGISTRY, deepseek: d2Provider("deepseek", cleared) } });

      const result = await ask(gateway);

      expect(result).toMatchObject({ kind: "answered", withheld: [] });
      expect(deepseek.calls[0].user).toContain("4250");
      expect(gateway.beginTurn(tenant).effectiveLimit("chat_reply")).toBe("D2");
    });

    it("a shadow call to a provider that is not cleared is capped too, while the cleared main provider gets D2", async () => {
      const main = new FakeProvider("deepseek", [REPLY]);
      const shadow = new FakeProvider("anthropic", [REPLY]);
      const { gateway, tenantAudit } = setup({
        providers: { deepseek: main, anthropic: shadow },
        routing: { standard: "deepseek", reasoning: "deepseek", shadow: "anthropic" },
        models: { deepseek: { standard: "flash", reasoning: "pro" }, anthropic: { standard: "haiku", reasoning: "opus" } },
        registry: { deepseek: d2Provider("deepseek", cleared), anthropic: d2Provider("anthropic") },
        tenantLimit: () => "D2",
      });

      await ask(gateway);
      await vi.waitFor(() => expect(shadow.calls).toHaveLength(1));

      expect(main.calls[0].user).toContain("4250");
      expect(shadow.calls[0].user).toContain("Admin");
      expect(shadow.calls[0].user).not.toContain("4250");
      expect(tenantAudit.decisions.map((d) => [d.provider, d.channel, d.effectiveLimit])).toEqual([
        ["deepseek", null, "D2"],
        ["anthropic", "shadow", "D1"],
      ]);
    });

    it("follows the routing: the same pharmacy data is withheld once the uncleared provider is the one routed", async () => {
      const cleared2 = new FakeProvider("deepseek", [REPLY]);
      const plain = new FakeProvider("anthropic", [REPLY]);
      const registry = { deepseek: d2Provider("deepseek", cleared), anthropic: d2Provider("anthropic") };
      const models = { deepseek: { standard: "flash", reasoning: "pro" }, anthropic: { standard: "haiku", reasoning: "opus" } };
      const routedToCleared = setup({ providers: { deepseek: cleared2, anthropic: plain }, models, registry, tenantLimit: () => "D2" });
      const routedToPlain = setup({
        providers: { deepseek: cleared2, anthropic: plain },
        routing: { standard: "anthropic", reasoning: "anthropic" },
        models,
        registry,
        tenantLimit: () => "D2",
      });

      await ask(routedToCleared.gateway);
      await ask(routedToPlain.gateway);

      expect(cleared2.calls[0].user).toContain("4250");
      expect(plain.calls[0].user).not.toContain("4250");
    });

    it("does not touch a person's own data: a personal call with a D2 choice still reaches an unreviewed provider", async () => {
      const { gateway, deepseek } = setup({
        registry: { ...PROVIDER_REGISTRY, deepseek: d2Provider("deepseek") },
        choices: Object.assign(new InMemoryChoices(), {
          current: () => ({ id: "c1", identityId: "u1", provider: "deepseek" as const, maxClass: "D2" as const, decidedOn: null, note: null, confirmedAt: "2026-10-08T10:00:00.000Z" }),
        }),
      });

      const result = await ask(gateway, personal);

      expect(result).toMatchObject({ kind: "answered", withheld: [] });
      expect(deepseek.calls[0].user).toContain("4250");
    });
  });
});
