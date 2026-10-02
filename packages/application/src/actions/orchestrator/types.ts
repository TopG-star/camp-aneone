import type {
  ActionCapabilities,
  ActionConfigRepository,
  ActionInstance,
  ActionInstanceRepository,
  ActorContext,
  EvidenceItem,
  Logger,
} from "@oneon/domain";
import type { ActionRegistry } from "../registry.js";
import type { KeyContext } from "../definition.js";

/** Side channel (spec §10.7): messages about actions, never actions themselves. */
export interface ActionNotifier {
  awaitingApproval(instance: ActionInstance, description: string): Promise<void>;
  rollbackFailed(instance: ActionInstance, description: string): Promise<void>;
}

export interface OrchestratorDeps {
  registry: ActionRegistry;
  repo: ActionInstanceRepository;
  configRepo: ActionConfigRepository;
  /** Readers and writers for the user the action runs for. Built by the composition root. */
  capabilities(userId: string): ActionCapabilities;
  notifier: ActionNotifier;
  logger: Logger;
  clock(): Date;
  newId(): string;
}

export interface ActionRequest {
  type: string;
  input: unknown;
  actor: ActorContext;
  initiator: string;
  keyContext: KeyContext;
  evidence: EvidenceItem[];
  resourceRef: string | null;
  retryOf?: { id: string; attemptNumber: number; idempotencyKey: string };
}

export type RequestOutcome =
  | { kind: "created" | "duplicate"; instance: ActionInstance }
  | { kind: "refused"; reason: "unknown_type" | "invalid_input" | "scope_mismatch"; issues: string[] };

export class ActionOperationError extends Error {
  constructor(readonly code: "not_found" | "not_allowed" | "conflict", message: string) {
    super(message);
    this.name = "ActionOperationError";
  }
}
