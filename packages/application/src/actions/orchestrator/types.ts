import type {
  ActionCapabilities,
  ActionConfigRepository,
  ActionInstance,
  ActionInstanceRepository,
  ActorContext,
  EvidenceItem,
  Logger,
  MembershipLike,
} from "@oneon/domain";
import type { ActionRegistry } from "../registry.js";
import type { ImpressoRxCalls, KeyContext } from "../definition.js";

/** The signed-in session a request runs in; absent for the sweeper and every other caller outside a request. */
export interface RequestSession {
  sessionId: string;
  identityId: string;
}

/** Why an approval could not be checked live (spec §9.3). Nothing was recorded. */
export type ApprovalRefusal = "membership_suspended" | "launch_required" | "impressorx_unreachable";

export class ApprovalCheckError extends Error {
  constructor(readonly reason: ApprovalRefusal) {
    super(reason);
    this.name = "ApprovalCheckError";
  }
}

/**
 * What the orchestrator needs from the layer that holds the person's delegated access to a pharmacy's ImpressoRx (spec §7, §9).
 * Absent, a tenant action can neither be approved nor executed: it fails closed.
 */
export interface TenantDelegation {
  /**
   * Spec §9.3: asks ImpressoRx now, through the approver's session, who they are in the tenant. The membership is the live snapshot,
   * already applied to the stored one. A refusal has done what its reason says (a 401 from ImpressoRx suspends the membership).
   */
  liveApprover(
    session: RequestSession | undefined,
    tenantId: string,
  ): Promise<{ ok: true; membership: MembershipLike } | { ok: false; refusal: ApprovalRefusal }>;
  /** After the approval is recorded: asks for the action's own grant. Never throws; when it is refused the approval stands. */
  issueActionGrant(input: { instance: ActionInstance; session: RequestSession; scope: string[]; absoluteExpiresAt: string }): Promise<void>;
  /**
   * Before the executor runs: the way to ImpressoRx for this action, through the session's attended grant in a request, else the
   * action's own grant. Throws DelegationRevokedError (after revoking the grant it used), DelegationUnreachableError, or an
   * ExternalCallError for any other refusal.
   */
  open(instance: ActionInstance, session: RequestSession | undefined): Promise<ImpressoRxCalls>;
  /** A tenant action reached a final status: its grant dies, here and at ImpressoRx. Never throws; the remote part is best effort. */
  release(instance: ActionInstance): void;
}

/** Side channel (spec §10.7): messages about actions, never actions themselves. */
export interface ActionNotifier {
  awaitingApproval(instance: ActionInstance, description: string): Promise<void>;
  rollbackFailed(instance: ActionInstance, description: string): Promise<void>;
}

export interface OrchestratorDeps {
  registry: ActionRegistry;
  repo: ActionInstanceRepository;
  configRepo: ActionConfigRepository;
  /** The current active membership of an identity at a tenant (registry tenant id), or null. */
  memberships: { activeFor(identityId: string, tenantId: string): MembershipLike | null };
  /** The person's delegated access to a pharmacy (tenant handles only). */
  delegation?: TenantDelegation;
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
  /** The request's session, when the action may run inside the request with the person's attended access. */
  session?: RequestSession;
  /** The model call that proposed the action (chat intent extraction). Absent for an action created any other way. */
  modelCallId?: string;
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
