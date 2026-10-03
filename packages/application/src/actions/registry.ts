import type { AnyActionDefinition } from "./definition.js";

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

/** Spec §4.2 R1: an action type exists only if it is registered here. */
export function createActionRegistry(definitions: AnyActionDefinition[]): ActionRegistry {
  const byType = new Map<string, AnyActionDefinition>();
  for (const def of definitions) {
    if (byType.has(def.type)) throw new Error(`Action type "${def.type}" is already registered`);
    byType.set(def.type, def);
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
