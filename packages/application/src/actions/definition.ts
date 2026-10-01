import type { z } from "zod";
import type {
  ActionError,
  ActionReaders,
  ActionScope,
  ActionWriters,
  ActorContext,
  CheckResult,
  JsonObject,
  RiskTier,
} from "@oneon/domain";
import type { EffectivePolicy, PolicyFloor } from "./policy/types.js";

export type RollbackClass = "reversible" | "conditional" | "irreversible";

export interface PreconditionResult extends CheckResult {
  kind: "blocking" | "obsolete";
}

/** An undo precondition; `failureCode` becomes the rollback_failed reason (e.g. changed_since). */
export interface UndoCheck extends CheckResult {
  failureCode: string;
}

/** Output of resolve: everything derived from current state that changes consequences (spec §9.2). */
export interface Resolved extends JsonObject {
  metrics: Record<string, number>;
}

export type ResolveResult<R> = { ok: true; resolved: R } | { ok: false; error: ActionError };

export interface CheckContext<I> {
  input: I;
  actor: ActorContext;
  readers: ActionReaders;
  now: Date;
}

export interface ExecuteContext<I, R> {
  instanceId: string;
  input: I;
  resolved: R;
  actor: ActorContext;
  executorRequestId: string;
  writers: ActionWriters;
  heartbeat: () => void;
  now: Date;
}

export type ExecutionOutcome =
  | { kind: "succeeded"; result: JsonObject; undoData: JsonObject | null }
  | { kind: "definite_failure"; code: string; message: string }
  | { kind: "unknown"; code: string; message: string };

export interface VerifyContext<I, R> {
  input: I;
  resolved: R;
  result: JsonObject | null;
  executorRequestId: string;
  readers: ActionReaders;
}

export interface Verification {
  checks: CheckResult[];
  /** The check that decides whether the effect exists at all. */
  effectCheckId: string;
}

export interface UndoContext<I, R> {
  input: I;
  resolved: R;
  result: JsonObject | null;
  undo: JsonObject;
  readers: ActionReaders;
  writers: ActionWriters;
}

export interface UndoSpec<I, R> {
  preconditions(ctx: UndoContext<I, R>): Promise<UndoCheck[]>;
  execute(ctx: UndoContext<I, R>): Promise<ExecutionOutcome>;
  verify(ctx: UndoContext<I, R>): Promise<CheckResult[]>;
  /** Shown in the undo confirmation, e.g. who Google will email. */
  warning(resolved: R): string | null;
}

export type KeyContext = { source: "rule"; resourceId: string } | { source: "chat"; turnId: string };

export interface ThresholdMetric {
  label: string;
  exceededText: string;
}

export interface ActionDefinition<I extends JsonObject = JsonObject, R extends Resolved = Resolved> {
  type: string;
  version: string;
  scope: ActionScope;
  label: string;
  description: string;
  inputSchema: z.ZodType<I, z.ZodTypeDef, unknown>;
  effects: { reads: string[]; writes: string[] };
  floor: PolicyFloor;
  defaults: EffectivePolicy;
  thresholdMetrics: Record<string, ThresholdMetric>;
  rollbackClass: RollbackClass;
  recoveryThresholdMs: number;
  executionTimeoutMs: number;
  disableWarning: string | null;
  unavailableReason: string | null;
  /** Resolved fields compared at execution; any difference fails with changed_since_approval. */
  consequenceKeys: readonly string[];
  idempotencyKey(input: I, ctx: KeyContext): string;
  preconditions(ctx: CheckContext<I>): Promise<PreconditionResult[]>;
  resolve(ctx: CheckContext<I>): Promise<ResolveResult<R>>;
  riskFor(resolved: R, floorRisk: RiskTier): RiskTier;
  describe(resolved: R, input: I): string;
  execute: ((ctx: ExecuteContext<I, R>) => Promise<ExecutionOutcome>) | null;
  postconditions: ((ctx: VerifyContext<I, R>) => Promise<Verification>) | null;
  undo: UndoSpec<I, R> | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyActionDefinition = ActionDefinition<any, any>;

export const DEFAULT_RECOVERY_THRESHOLD_MS = 5 * 60 * 1000;
export const PERSONAL_APPROVERS = ["owner"];
