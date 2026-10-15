import type { AnyActionDefinition } from "./definition.js";
import { TENANT_MAX_APPROVAL_AGE_HOURS } from "./policy/types.js";

export class ActionTypeNotFoundError extends Error {
  constructor(readonly actionType: string) {
    super(`Action type "${actionType}" is not registered`);
    this.name = "ActionTypeNotFoundError";
  }
}

export interface ActionRegistry {
  get(type: string): AnyActionDefinition;
  has(type: string): boolean;
  list(): AnyActionDefinition[];
}

/**
 * Spec §7.6: every tenant-scope definition carries a `maxApprovalAgeHours` floor, at most TENANT_MAX_APPROVAL_AGE_HOURS. A definition that
 * declares none gets the maximum here, so no tenant action can be registered without an age limit; one that declares a larger value, or
 * a limit that is not a positive number, is refused when the registry is built.
 */
function withApprovalAgeFloor(def: AnyActionDefinition): AnyActionDefinition {
  if (def.scope !== "tenant") return def;
  const declared = def.floor.maxApprovalAgeHours;
  if (declared === undefined) return { ...def, floor: { ...def.floor, maxApprovalAgeHours: TENANT_MAX_APPROVAL_AGE_HOURS } };
  if (!(declared > 0 && declared <= TENANT_MAX_APPROVAL_AGE_HOURS)) {
    throw new Error(`Action type "${def.type}" declares maxApprovalAgeHours ${declared}; a tenant action's limit is 1 to ${TENANT_MAX_APPROVAL_AGE_HOURS} hours`);
  }
  return def;
}

/** Spec §4.2 R1: an action type exists only if it is registered here. */
export function createActionRegistry(definitions: AnyActionDefinition[]): ActionRegistry {
  const byType = new Map<string, AnyActionDefinition>();
  for (const declared of definitions) {
    if (byType.has(declared.type)) throw new Error(`Action type "${declared.type}" is already registered`);
    byType.set(declared.type, withApprovalAgeFloor(declared));
  }
  return {
    get(type) {
      const def = byType.get(type);
      if (!def) throw new ActionTypeNotFoundError(type);
      return def;
    },
    has: (type) => byType.has(type),
    list: () => [...byType.values()],
  };
}
