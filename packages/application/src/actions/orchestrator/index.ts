import type { ActionInstance } from "@oneon/domain";
import { createAdvance } from "./advance.js";
import { createRequestAction } from "./request-action.js";
import type { ActionRequest, OrchestratorDeps, RequestOutcome } from "./types.js";

export * from "./types.js";
export { effectivePolicyFor, describeInstance } from "./shared.js";

export interface ActionOrchestrator {
  requestAction(req: ActionRequest): Promise<RequestOutcome>;
  advance(ownerId: string, actionId: string): Promise<ActionInstance>;
}

export function createActionOrchestrator(deps: OrchestratorDeps): ActionOrchestrator {
  const advance = createAdvance(deps);
  const requestAction = createRequestAction(deps, advance);
  return { requestAction, advance };
}
