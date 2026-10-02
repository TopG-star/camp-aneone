import type { ActionInstance, ActorContext } from "@oneon/domain";
import { createAdvance } from "./advance.js";
import { createDecisions } from "./decisions.js";
import { createRequestAction } from "./request-action.js";
import { createSweeper } from "./sweeper.js";
import { createUndo } from "./undo.js";
import type { ActionRequest, OrchestratorDeps, RequestOutcome } from "./types.js";

export * from "./types.js";
export { effectivePolicyFor, describeInstance } from "./shared.js";

export interface ActionOrchestrator {
  requestAction(req: ActionRequest): Promise<RequestOutcome>;
  advance(ownerId: string, actionId: string): Promise<ActionInstance>;
  approve(actor: ActorContext, actionId: string): Promise<ActionInstance>;
  reject(actor: ActorContext, actionId: string, reason?: string): Promise<ActionInstance>;
  cancel(actor: ActorContext, actionId: string, reason?: string): Promise<ActionInstance>;
  retry(actor: ActorContext, actionId: string): Promise<RequestOutcome>;
  requestUndo(actor: ActorContext, actionId: string): Promise<ActionInstance>;
  sweep(ownerId: string): Promise<{ recovered: number }>;
  expireStale(ownerId: string): Promise<number>;
}

export function createActionOrchestrator(deps: OrchestratorDeps): ActionOrchestrator {
  const advance = createAdvance(deps);
  const requestAction = createRequestAction(deps, advance);
  const { requestUndo, continueUndo } = createUndo(deps);
  const { approve, reject, cancel, retry } = createDecisions(deps, advance, requestAction);
  const { sweep, expireStale } = createSweeper(deps, advance, continueUndo);
  return { requestAction, advance, approve, reject, cancel, retry, requestUndo, sweep, expireStale };
}
