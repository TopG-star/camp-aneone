import { describe, it, expect, vi } from "vitest";
import type { LegacyActionRepository, LegacyActionRow } from "@oneon/domain";
import { importLegacyProposals } from "./legacy-import.js";
import { silentLogger } from "./__tests__/orchestrator-harness.js";

const row = (over: Partial<LegacyActionRow>): LegacyActionRow => ({
  id: "l1", userId: "u1", resourceId: "i1", actionType: "archive", riskLevel: "approval_required",
  status: "proposed", payloadJson: '{"reason":"spam_classification"}', resultJson: null, errorJson: null,
  createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", ...over,
});

function legacyRepo(rows: LegacyActionRow[]) {
  const imported: Array<[string, string]> = [];
  const repo: LegacyActionRepository = {
    listForUser: () => [],
    countForUser: () => 0,
    listUnimportedProposed: (userId) => rows.filter((r) => r.userId === userId),
    recordImport: (legacyId, actionId) => imported.push([legacyId, actionId]),
  };
  return { repo, imported };
}

describe("importLegacyProposals", () => {
  it("imports supported proposals and records the mapping", async () => {
    const { repo, imported } = legacyRepo([
      row({ id: "l1" }),
      row({ id: "l2", actionType: "create_reminder", resourceId: "d1", payloadJson: '{"inboundItemId":"i9"}' }),
    ]);
    const requestAction = vi.fn(async (req) => ({ kind: "created" as const, instance: { id: `new-${req.type}` } as never }));
    const result = await importLegacyProposals({ legacyRepo: repo, requestAction, userIds: ["u1"], logger: silentLogger });
    expect(result).toEqual({ imported: 2, skipped: 0 });
    expect(imported).toEqual([["l1", "new-archive"], ["l2", "new-create_reminder"]]);
    expect(requestAction.mock.calls[1][0]).toMatchObject({
      type: "create_reminder",
      input: { deadlineId: "d1", inboundItemId: "i9" },
      initiator: "rule:inbox.deadline_reminder",
      resourceRef: "deadline:d1",
    });
    expect(requestAction.mock.calls[0][0].evidence[0]).toMatchObject({ kind: "legacy_action", data: { legacyId: "l1" } });
  });

  it("never re-runs notify, skips unknown types and leaves other users' rows alone (Review Focus 4)", async () => {
    const { repo, imported } = legacyRepo([
      row({ id: "n1", actionType: "notify" }),
      row({ id: "c1", actionType: "classify" }),
      row({ id: "x1", userId: null }),
      row({ id: "o1", userId: "u2" }),
      row({ id: "bad", payloadJson: "not json" }),
    ]);
    const requestAction = vi.fn(async () => ({ kind: "created" as const, instance: { id: "new" } as never }));
    const result = await importLegacyProposals({ legacyRepo: repo, requestAction, userIds: ["u1"], logger: silentLogger });
    expect(result).toEqual({ imported: 1, skipped: 2 });
    expect(imported).toEqual([["bad", "new"]]);
    expect(requestAction).toHaveBeenCalledTimes(1);
    expect(requestAction).toHaveBeenCalledWith(expect.objectContaining({ actor: expect.objectContaining({ userId: "u1" }) }));
  });

  it("a request that throws skips only that row", async () => {
    const { repo, imported } = legacyRepo([row({ id: "a" }), row({ id: "boom" }), row({ id: "c" })]);
    let calls = 0;
    const requestAction = vi.fn(async () => {
      calls++;
      if (calls === 2) throw new Error("db locked");
      return { kind: "created" as const, instance: { id: `new-${calls}` } as never };
    });
    const warn = vi.fn();
    const result = await importLegacyProposals({ legacyRepo: repo, requestAction, userIds: ["u1"], logger: { ...silentLogger, warn } });
    expect(result).toEqual({ imported: 2, skipped: 1 });
    expect(imported).toEqual([["a", "new-1"], ["c", "new-3"]]);
    expect(warn).toHaveBeenCalledWith("Legacy proposal import threw", { legacyId: "boom", error: "db locked" });
  });

  it("skips a refused request without recording it", async () => {
    const { repo, imported } = legacyRepo([row({ id: "l1" })]);
    const requestAction = vi.fn(async () => ({ kind: "refused" as const, reason: "invalid_input" as const, issues: ["x"] }));
    expect(await importLegacyProposals({ legacyRepo: repo, requestAction, userIds: ["u1"], logger: silentLogger })).toEqual({ imported: 0, skipped: 1 });
    expect(imported).toEqual([]);
  });
});
