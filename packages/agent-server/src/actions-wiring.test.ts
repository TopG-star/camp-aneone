import { describe, it, expect, vi } from "vitest";
import type { Logger } from "@oneon/domain";
import { runActionRecovery, runActionStartupTasks, type ActionsModule } from "./actions-wiring.js";

vi.mock("@oneon/infrastructure", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oneon/infrastructure")>()),
  runActionDriftCheck: vi.fn().mockReturnValue(0),
}));

function fakeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

function fakeContainer(opts: { importThrows?: boolean; sweepThrowsFor?: string }) {
  const sweep = vi.fn(async (userId: string) => {
    if (userId === opts.sweepThrowsFor) throw new Error("sweep boom");
    return { recovered: 0 };
  });
  const expireStale = vi.fn(async (_userId: string) => 0);
  const listUnimportedProposed = vi.fn((_userId: string) => {
    if (opts.importThrows) throw new Error("import boom");
    return [];
  });
  const actions = {
    legacyRepo: { listUnimportedProposed },
    orchestrator: { requestAction: vi.fn(), sweep, expireStale },
  } as unknown as ActionsModule;
  const userRepo = { list: () => [{ id: "u1" }, { id: "u2" }] };
  return { container: { db: {} as never, actions, userRepo }, sweep, expireStale };
}

describe("runActionStartupTasks", () => {
  it("resolves and still recovers every user when the legacy import throws", async () => {
    const { container, sweep, expireStale } = fakeContainer({ importThrows: true });
    const logger = fakeLogger();
    await expect(runActionStartupTasks(container, logger)).resolves.toBeUndefined();
    expect(sweep.mock.calls.map((c) => c[0])).toEqual(["u1", "u2"]);
    expect(expireStale.mock.calls.map((c) => c[0])).toEqual(["u1", "u2"]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("resolves and still recovers the other users when one user's sweep throws", async () => {
    const { container, sweep, expireStale } = fakeContainer({ sweepThrowsFor: "u1" });
    const logger = fakeLogger();
    await expect(runActionStartupTasks(container, logger)).resolves.toBeUndefined();
    expect(sweep.mock.calls.map((c) => c[0])).toEqual(["u1", "u2"]);
    expect(expireStale.mock.calls.map((c) => c[0])).toEqual(["u1", "u2"]);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe("runActionRecovery", () => {
  it("never throws and still expires when sweep fails", async () => {
    const { container, expireStale } = fakeContainer({ sweepThrowsFor: "u1" });
    const logger = fakeLogger();
    await expect(runActionRecovery(container.actions, "u1", logger)).resolves.toBeUndefined();
    expect(expireStale).toHaveBeenCalledWith("u1");
    expect(logger.warn).toHaveBeenCalled();
  });
});
