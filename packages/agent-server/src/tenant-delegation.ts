import { DelegationRevokedError, DelegationUnreachableError, ExternalCallError, type ActionInstance, type Logger, type MembershipLike } from "@oneon/domain";
import type { ImpressoRxCalls, RequestSession, TenantDelegation } from "@oneon/application";
import {
  ImpressoRxRefusedError,
  ImpressoRxUnreachableError,
  type GrantCalls,
  type ImpressoRxClient,
} from "@oneon/infrastructure";
import type { SnapshotRefresher } from "./middleware/active-context.js";

export interface TenantDelegationDeps {
  /** The ImpressoRx client; null when delegation is not configured, and every tenant action then fails closed. */
  client: Pick<ImpressoRxClient, "forBoundSession" | "forActionGrant" | "revokeActionGrant"> | null;
  /** The identity's current active membership at the tenant whose rows carry this registry tenant id. */
  memberships: { activeFor(identityId: string, tenantId: string): (MembershipLike & { id: string; identityId: string }) | null };
  snapshots: Pick<SnapshotRefresher, "checkLive">;
  logger: Logger;
}

type Failure = "unreachable" | "revoked" | "refused";

/**
 * What went wrong with a call to ImpressoRx, as the orchestrator needs to tell it (spec §9.2, Task 19 ruling):
 * - unreachable: network, timeout, 5xx, 503 (and a reply that is not understood). Never a revocation.
 * - revoked: a 401 from ImpressoRx itself, or Oneon's own refusal to use a grant that is missing, expired or revoked here (the client
 *   marks these with the default status 401). The access is gone.
 * - refused: any other HTTP status (a tRPC FORBIDDEN, a 404). A permanent answer; nothing is retried.
 */
function classify(error: unknown): Failure | null {
  if (error instanceof ImpressoRxUnreachableError) return "unreachable";
  if (error instanceof ImpressoRxRefusedError) return error.status === 401 ? "revoked" : "refused";
  return null;
}

/**
 * The person's delegated access to a pharmacy's ImpressoRx, for tenant actions (spec §7, §9). Every attended call goes through the
 * grant bound to the session, the identity and the membership at the action's tenant (client.forBoundSession), never the unbound
 * session lookup.
 */
export function createTenantDelegation(deps: TenantDelegationDeps): TenantDelegation {
  const { client, logger } = deps;

  /**
   * The attended grant of this request's session for the session's own identity's membership at the action's tenant, if it holds a
   * usable one. The session's identity is the person present (the approver), who is not necessarily the person who proposed the action.
   */
  function attendedFor(instance: ActionInstance, session: RequestSession | undefined): GrantCalls | null {
    if (!client || !session) return null;
    const membership = deps.memberships.activeFor(session.identityId, instance.tenantId!);
    return membership ? client.forBoundSession(session.sessionId, session.identityId, membership.id) : null;
  }

  return {
    async liveApprover(session, tenantId) {
      if (!session) return { ok: false, refusal: "launch_required" };
      const membership = deps.memberships.activeFor(session.identityId, tenantId);
      if (!membership) return { ok: false, refusal: "launch_required" };
      const live = await deps.snapshots.checkLive({ sessionId: session.sessionId, membership });
      return live.ok ? { ok: true, membership: live.membership } : { ok: false, refusal: live.reason };
    },

    async issueActionGrant({ instance, session, scope, absoluteExpiresAt }) {
      const membership = deps.memberships.activeFor(session.identityId, instance.tenantId!);
      const attended = client && membership ? client.forBoundSession(session.sessionId, session.identityId, membership.id) : null;
      if (!attended) return;
      try {
        await attended.issue({ kind: "action", oneonActionId: instance.id, scope, absoluteExpiresAt });
      } catch (error) {
        // Most often unattended access is off at the pharmacy, which ImpressoRx answers like any refusal. The approval stands and the
        // action runs now with the session; if that cannot happen it follows the failure mapping.
        logger.warn("No action grant was issued", { actionId: instance.id, error: error instanceof Error ? error.name : "unknown" });
      }
    },

    async open(instance, session): Promise<ImpressoRxCalls> {
      const attended = attendedFor(instance, session);
      const grant = attended ?? client?.forActionGrant(instance.id) ?? null;
      if (!client || !grant) throw new DelegationRevokedError();

      /** The grant that failed is revoked here (at ImpressoRx too, best effort) before the action is failed. */
      const revokeUsedGrant = async () => {
        if (attended) await attended.revoke().catch(() => undefined);
        else await client.revokeActionGrant(instance.id, "delegation_revoked");
      };
      const translate = async (error: unknown, stage: "open" | "call"): Promise<unknown> => {
        const failure = classify(error);
        if (failure === "unreachable") return new DelegationUnreachableError();
        if (failure === "revoked") {
          await revokeUsedGrant();
          return new DelegationRevokedError();
        }
        if (failure === "refused") {
          const status = (error as ImpressoRxRefusedError).status;
          logger.warn("ImpressoRx refused the request", { actionId: instance.id, stage, status });
          return new ExternalCallError("definite", "impressorx_refused", `ImpressoRx answered ${status}`);
        }
        return error;
      };

      try {
        await grant.accessToken({ oneonActionId: instance.id });
      } catch (error) {
        throw await translate(error, "open");
      }
      return {
        async trpc<T>(path: string, input: unknown, type: "query" | "mutation"): Promise<T> {
          try {
            return await grant.trpc<T>(path, input, type, { oneonActionId: instance.id });
          } catch (error) {
            throw await translate(error, "call");
          }
        },
      };
    },

    release(instance) {
      if (!client) return;
      // Locally revoked before the first await, so the grant is unusable at once; the rest is best effort.
      client.revokeActionGrant(instance.id, `action_${instance.status}`).catch((error: unknown) => {
        logger.warn("Revoking an action's grant failed", { actionId: instance.id, error: error instanceof Error ? error.message : String(error) });
      });
    },
  };
}
