import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import { createModelGateway } from "./gateway.js";
import { Fingerprinter } from "./fingerprints.js";
import { InMemoryChoices, InMemoryModelAudit } from "./__tests__/in-memory-audit.js";
import { FakeProvider } from "./__tests__/fake-provider.js";
import { classRank, type DataClass } from "./types.js";

const classArb = fc.constantFrom<DataClass | null>("D0", "D1", "D2", "D3", null);

describe("gateway invariant (spec §12)", () => {
  it("never sends a value above the effective limit, never sends D3 or D4, never stores values or the mapping", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ cls: classArb, entity: fc.boolean(), rowD3: fc.boolean() }), { minLength: 1, maxLength: 8 }),
        fc.constantFrom<"D1" | "D2">("D1", "D2"),
        fc.constantFrom<"personal" | "tenant">("personal", "tenant"),
        async (specs, choice, kind) => {
          const provider = new FakeProvider("deepseek", [JSON.stringify({ answer: "ok", usedTools: [] })]);
          const audit = new InMemoryModelAudit();
          const choices = new InMemoryChoices();
          if (choice === "D2") choices.record({ identityId: "u1", provider: "deepseek", maxClass: "D2", decidedOn: null, note: null, confirmedAt: "x" });
          const gateway = createModelGateway({
            providers: { deepseek: provider },
            overrides: new Map(),
            routing: { standard: "deepseek", reasoning: "deepseek" },
            models: { deepseek: { standard: "s", reasoning: "r" } },
            choices,
            audit,
            fingerprinter: new Fingerprinter("k".repeat(32), 1),
            maxRetries: 0,
            timeouts: { standard: 1, reasoning: 1 },
            logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          });
          const context = kind === "personal" ? { kind, identityId: "u1" } as const : { kind, identityId: "u1", tenantId: "t1", membershipId: "m1" } as const;
          const limit: DataClass = kind === "tenant" ? "D1" : choice;
          const values = specs.map((_, i) => `VAL${i}X${Math.random().toString(36).slice(2, 8)}`);
          const rows = specs.map((s, i) => ({
            ...(s.rowD3 ? { rowClass: "D3" as const } : {}),
            fields: [{ name: `f${i}`, class: s.cls, value: values[i], ...(s.entity ? { entity: { type: "customer", id: `c${i}` } } : {}) }],
          }));
          await gateway.beginTurn(context).call({ purpose: "chat_reply", output: "json", parts: [{ kind: "user_message", text: "q" }, { kind: "record", source: "tool:t", rows }] });
          const sent = provider.calls.map((c) => c.system + c.user).join("\n");
          specs.forEach((s, i) => {
            const effective = s.rowD3 ? "D3" : s.cls;
            const mayAppearRaw = effective !== null && effective !== "D3" && classRank(effective) <= classRank(limit);
            if (!mayAppearRaw) expect(sent).not.toContain(values[i]);
          });
          const stored = JSON.stringify([audit.decisions, audit.outcomes]);
          for (const v of values) expect(stored).not.toContain(v);
        },
      ),
      { numRuns: 200 },
    );
  });
});
