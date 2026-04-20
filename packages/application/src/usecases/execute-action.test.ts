import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeAction, type ExecuteActionDeps } from "./execute-action.js";
import type { ActionLogEntry, ActionLogRepository, Logger } from "@oneon/domain";

// ── Helpers ──────────────────────────────────────────────────

function createMockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeFakeAction(overrides: Partial<ActionLogEntry> = {}): ActionLogEntry {
  return {
    id: "action-001",
    userId: null,
    resourceId: "item-001",
    actionType: "notify",
    riskLevel: "auto",
    status: "proposed",
    payloadJson: "{}",
    resultJson: null,
    errorJson: null,
    rollbackJson: null,
    createdAt: "2026-04-10T09:02:00Z",
    updatedAt: "2026-04-10T09:02:00Z",
    ...overrides,
  };
}

function createMockActionLogRepo(): ActionLogRepository {
  return {
    create: vi.fn(),
    findByResourceAndType: vi.fn(),
    findByStatus: vi.fn(),
    updateStatus: vi.fn(),
    findAll: vi.fn(),
    count: vi.fn(),
  };
}

function createDeps(overrides: Partial<ExecuteActionDeps> = {}): ExecuteActionDeps {
  return {
    actionLogRepo: createMockActionLogRepo(),
    logger: createMockLogger(),
    featureAutoExecute: true,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────

describe("executeAction", () => {
  let deps: ExecuteActionDeps;

  beforeEach(() => {
    deps = createDeps();
  });

  // ── Auto-execute path ─────────────────────────────────────

  it("auto-executes auto-risk actions when feature flag is on", () => {
    const action = makeFakeAction({ riskLevel: "auto", status: "proposed" });

    const result = executeAction(deps, action);

    expect(result.outcome).toBe("executed");
    expect(deps.actionLogRepo.updateStatus).toHaveBeenCalledTimes(2);
  });

  it("transitions proposed → approved → executed", () => {
    const action = makeFakeAction({ riskLevel: "auto", status: "proposed" });

    executeAction(deps, action);

    const calls = (deps.actionLogRepo.updateStatus as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toBe("action-001");
    expect(calls[0][1]).toBe("approved");
    expect(calls[1][0]).toBe("action-001");
    expect(calls[1][1]).toBe("executed");
  });

  it("stores resultJson with executedAt and mode=auto", () => {
    const action = makeFakeAction({ riskLevel: "auto", status: "proposed" });

    executeAction(deps, action);

    const calls = (deps.actionLogRepo.updateStatus as ReturnType<typeof vi.fn>).mock.calls;
    const executedCall = calls[1];
    const data = executedCall[2];
    const parsed = JSON.parse(data.resultJson);
    expect(parsed.mode).toBe("auto");
    expect(parsed.executedAt).toBeDefined();
  });

  it("returns action snapshot with status=executed", () => {
    const action = makeFakeAction({ riskLevel: "auto", status: "proposed" });

    const result = executeAction(deps, action);

    expect(result.action.status).toBe("executed");
    expect(result.action.resultJson).toBeDefined();
  });

  // ── Feature flag off ──────────────────────────────────────

  it("does NOT execute when featureAutoExecute is off", () => {
    deps = createDeps({ featureAutoExecute: false });
    const action = makeFakeAction({ riskLevel: "auto", status: "proposed" });

    const result = executeAction(deps, action);

    expect(result.outcome).toBe("skipped_feature_off");
    expect(deps.actionLogRepo.updateStatus).not.toHaveBeenCalled();
  });

  // ── Approval-required path ────────────────────────────────

  it("does NOT execute approval-required actions", () => {
    const action = makeFakeAction({
      riskLevel: "approval_required",
      actionType: "archive",
      status: "proposed",
    });

    const result = executeAction(deps, action);

    expect(result.outcome).toBe("awaiting_approval");
    expect(deps.actionLogRepo.updateStatus).not.toHaveBeenCalled();
  });

  it("returns awaiting_approval for approval-required even with flag on", () => {
    deps = createDeps({ featureAutoExecute: true });
    const action = makeFakeAction({
      riskLevel: "approval_required",
      status: "proposed",
    });

    const result = executeAction(deps, action);

    expect(result.outcome).toBe("awaiting_approval");
  });

  // ── Non-proposed actions ──────────────────────────────────

  it("skips already-approved actions", () => {
    const action = makeFakeAction({ status: "approved" });

    const result = executeAction(deps, action);

    expect(result.outcome).toBe("skipped_feature_off");
    expect(deps.logger.warn).toHaveBeenCalledWith(
      "executeAction called on non-proposed action, skipping",
      expect.objectContaining({ actionId: "action-001", currentStatus: "approved" })
    );
  });

  it("skips already-executed actions", () => {
    const action = makeFakeAction({ status: "executed" });

    const result = executeAction(deps, action);

    expect(result.outcome).toBe("skipped_feature_off");
  });

  // ── Logging ───────────────────────────────────────────────

  it("logs auto-executed actions", () => {
    const action = makeFakeAction({ riskLevel: "auto", status: "proposed" });

    executeAction(deps, action);

    expect(deps.logger.info).toHaveBeenCalledWith(
      "Action auto-executed",
      expect.objectContaining({ actionId: "action-001" })
    );
  });

  it("logs approval-awaiting actions", () => {
    const action = makeFakeAction({
      riskLevel: "approval_required",
      status: "proposed",
    });

    executeAction(deps, action);

    expect(deps.logger.info).toHaveBeenCalledWith(
      "Action awaiting approval",
      expect.objectContaining({ actionId: "action-001" })
    );
  });
});
