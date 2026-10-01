import type { z } from "zod";
import type { JsonObject, RiskTier } from "@oneon/domain";
import { chatKey, emailKey } from "../idempotency.js";
import {
  DEFAULT_RECOVERY_THRESHOLD_MS,
  PERSONAL_APPROVERS,
  type ActionDefinition,
  type Resolved,
  type RollbackClass,
} from "../definition.js";
import type { ApprovalMode } from "../policy/types.js";

/** Spec §9.8: registered so floors are in force, refused by policy until Gmail access exists. */
export function unavailableDefinition<I extends JsonObject & { inboundItemId: string }>(spec: {
  type: string;
  label: string;
  description: string;
  reason: string;
  riskFloor: RiskTier;
  approvalFloor: ApprovalMode;
  rollbackClass: RollbackClass;
  inputSchema: z.ZodType<I, z.ZodTypeDef, unknown>;
  describe: (input: I) => string;
}): ActionDefinition<I, Resolved> {
  const floor = {
    risk: spec.riskFloor,
    approval: { mode: spec.approvalFloor, thresholds: {} },
    requiredPermissions: [],
    approverRoles: PERSONAL_APPROVERS,
    expiryHours: 168,
  };
  return {
    type: spec.type,
    version: "1",
    scope: "personal",
    label: spec.label,
    description: spec.description,
    inputSchema: spec.inputSchema,
    effects: { reads: ["Gmail message"], writes: ["Gmail mailbox"] },
    floor,
    defaults: { ...floor, enabled: true },
    thresholdMetrics: {},
    rollbackClass: spec.rollbackClass,
    recoveryThresholdMs: DEFAULT_RECOVERY_THRESHOLD_MS,
    executionTimeoutMs: 10_000,
    disableWarning: null,
    unavailableReason: spec.reason,
    consequenceKeys: [],
    idempotencyKey: (input, ctx) => (ctx.source === "rule" ? emailKey(input.inboundItemId) : chatKey(ctx.turnId, input)),
    preconditions: async () => [],
    resolve: async () => ({ ok: true, resolved: { metrics: {} } }),
    riskFor: (_resolved, floorRisk) => floorRisk,
    describe: (_resolved, input) => spec.describe(input),
    execute: null,
    postconditions: null,
    undo: null,
  };
}
