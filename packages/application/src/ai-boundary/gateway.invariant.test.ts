import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import { createModelGateway } from "./gateway.js";
import { Fingerprinter } from "./fingerprints.js";
import { InMemoryChoices, InMemoryModelAudit } from "./__tests__/in-memory-audit.js";
import { FakeProvider } from "./__tests__/fake-provider.js";
import { classRank, type DataClass } from "./types.js";

const classArb = fc.constantFrom<DataClass | null>("D0", "D1", "D2", "D3", "D4", null);
const textKindArb = fc.constantFrom<"plain" | "d3" | "d4">("plain", "d3", "d4");

describe("gateway invariant (spec §12)", () => {
  it("never sends a value above the effective limit, never sends D3 or D4, never stores or logs values or the mapping", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            cls: classArb,
            entity: fc.boolean(),
            rowD3: fc.boolean(),
            freeText: fc.boolean(),
            kind: textKindArb,
            salt: fc.nat({ max: 99999 }),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        fc.record({ withHistory: fc.boolean(), userKind: textKindArb, salt: fc.nat({ max: 99999 }) }),
        fc.constantFrom<"D1" | "D2">("D1", "D2"),
        fc.constantFrom<"personal" | "tenant">("personal", "tenant"),
        async (specs, history, choice, kind) => {
          const provider = new FakeProvider("deepseek", [JSON.stringify({ answer: "ok", usedTools: [] })]);
          const audit = new InMemoryModelAudit();
          const choices = new InMemoryChoices();
          const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
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
            logger,
          });
          const context = kind === "personal" ? ({ kind, identityId: "u1" } as const) : ({ kind, identityId: "u1", tenantId: "t1", membershipId: "m1" } as const);
          const limit: DataClass = kind === "tenant" ? "D1" : choice;

          // Values are derived from the generated case, so a failing case replays exactly.
          const values = specs.map((s, i) => `VAL${i}X${s.salt}`);
          // Text a scanner must catch: a D3 phrase's tail (removed) or a D4 pattern (deny).
          const d3Secrets = specs.map((s, i) => `DXSECRET${i}Y${s.salt}`);
          const d4Secrets = specs.map((s, i) => `hunter${i}z${s.salt}`);
          const fieldValue = (s: (typeof specs)[number], i: number) =>
            !s.freeText || s.kind === "plain" ? values[i] : s.kind === "d3" ? `${values[i]} diagnosed with ${d3Secrets[i]}` : `${values[i]} password: ${d4Secrets[i]}`;
          const rows = specs.map((s, i) => ({
            ...(s.rowD3 ? { rowClass: "D3" as const } : {}),
            fields: [
              {
                name: `f${i}`,
                class: s.cls,
                value: fieldValue(s, i),
                ...(s.freeText ? { freeText: true } : {}),
                ...(s.entity ? { entity: { type: "customer", id: `c${i}` } } : {}),
              },
            ],
          }));
          const userSecret = `HISTDXSECRET${history.salt}`;
          const userTurn = `HISTU${history.salt}`;
          const assistantTurn = `HISTA${history.salt}`;
          const userTurnText = history.userKind === "plain" ? userTurn : history.userKind === "d3" ? `${userTurn} prescribed ${userSecret}` : `${userTurn} password: ${userSecret}`;
          const parts = [
            { kind: "user_message" as const, text: "q" },
            ...(history.withHistory
              ? [
                  {
                    kind: "history" as const,
                    turns: [
                      { role: "user" as const, text: userTurnText },
                      { role: "assistant" as const, text: assistantTurn },
                    ],
                  },
                ]
              : []),
            { kind: "record" as const, source: "tool:t", rows },
          ];

          const result = await gateway.beginTurn(context).call({ purpose: "chat_reply", output: "json", parts });

          const sent = provider.calls.map((c) => c.system + c.user).join("\n");
          const mustDeny = specs.some((s) => s.cls === "D4" || (s.freeText && s.kind === "d4"));
          // C4 by location: a D4 hit in an earlier history turn withholds that turn only; the call still goes out.
          const historyTurnWithheld = history.withHistory && history.userKind === "d4";

          // Decision: deny on any D4 with no provider call; otherwise allow and call the provider once.
          expect(audit.decisions).toHaveLength(1);
          expect(audit.decisions[0].effectiveLimit).toBe(limit);
          if (mustDeny) {
            expect(result.kind).toBe("denied");
            expect(audit.decisions[0].decision).toBe("deny");
            expect(provider.calls).toHaveLength(0);
          } else {
            expect(audit.decisions[0].decision).toBe("allow");
            expect(provider.calls).toHaveLength(1);
            expect(sent).toContain("q");
          }

          specs.forEach((s, i) => {
            const effective = s.rowD3 ? "D3" : s.cls;
            const mayAppearRaw = !mustDeny && effective !== null && effective !== "D3" && effective !== "D4" && classRank(effective) <= classRank(limit);
            if (mayAppearRaw) expect(sent).toContain(values[i]);
            else expect(sent).not.toContain(values[i]);
            // Scanner-matched text never leaves, even when the rest of the field is allowed.
            expect(sent).not.toContain(d3Secrets[i]);
            expect(sent).not.toContain(d4Secrets[i]);
          });

          if (history.withHistory) {
            expect(sent).not.toContain(userSecret);
            if (!mustDeny) {
              // History turns follow the same limit: user text is D1, assistant text is D2.
              if (historyTurnWithheld) expect(sent).not.toContain(userTurn);
              else expect(sent).toContain(userTurn);
              if (limit === "D2") expect(sent).toContain(assistantTurn);
              else expect(sent).not.toContain(assistantTurn);
            } else {
              expect(sent).not.toContain(userTurn);
            }
          }

          // Nothing generated reaches the audit rows or the logger.
          const stored = JSON.stringify([audit.decisions, audit.outcomes]);
          const logged = JSON.stringify([logger.debug.mock.calls, logger.info.mock.calls, logger.warn.mock.calls, logger.error.mock.calls]);
          const everything = [...values, ...d3Secrets, ...d4Secrets, userSecret, userTurn, assistantTurn];
          for (const v of everything) {
            expect(stored).not.toContain(v);
            expect(logged).not.toContain(v);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
