import { randomUUID } from "node:crypto";
import { Router } from "express";
import { decodeJwt } from "jose";
import type { Logger, TenantDb } from "@oneon/domain";
import {
  EnrolmentFailedError,
  ImpressoRxRefusedError,
  ImpressoRxUnreachableError,
  TenantRefusedError,
  ensureIdentityAnchor,
  type EnrolmentService,
  type IdentityRepository,
  type ImpressoRxClient,
  type MembershipRepository,
  type TenantRegistrationRepository,
  type UsedHandoffJti,
} from "@oneon/infrastructure";

export type HandoffRejection = "expired" | "generic" | "membership_suspended";

/** A hand-off grant lives 60 s (the contract); a longer one is not ours. */
const HANDOFF_MAX_TTL_SECONDS = 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface HandoffRouterDeps {
  registrations: Pick<TenantRegistrationRepository, "findByIssuer">;
  enrolment: Pick<EnrolmentService, "verifyFromDeployment">;
  identities: Pick<IdentityRepository, "findByLogin" | "createWithLogin" | "findById">;
  memberships: Pick<MembershipRepository, "upsertFromHandoff" | "findById">;
  jti: Pick<UsedHandoffJti, "consume">;
  openTenant: (registrationId: string) => TenantDb;
  /** Null when ONEON_GRANT_MASTER_KEY is not configured: every hand-off is then rejected. */
  client: Pick<ImpressoRxClient, "exchangeHandoff" | "forSession"> | null;
  logger: Logger;
}

class Rejected extends Error {
  constructor(readonly reason: HandoffRejection) {
    super(reason);
  }
}

/**
 * Hand-off redemption for the dashboard's server side (service-token auth, mounted by the caller).
 * Every failure is the same 401 shape; only `reason` varies, and only among the three the person is told about.
 */
export function createHandoffRouter(deps: HandoffRouterDeps): Router {
  const router = Router();

  const reject = (res: import("express").Response, reason: HandoffRejection) =>
    res.status(401).json({ error: "handoff_rejected", reason });

  router.post("/redeem", async (req, res) => {
    const { handoff, sessionId, origin } = (req.body ?? {}) as { handoff?: unknown; sessionId?: unknown; origin?: unknown };
    try {
      if (typeof handoff !== "string" || handoff.length === 0 || handoff.length > 8192) throw new Rejected("generic");
      if (typeof sessionId !== "string" || !UUID.test(sessionId)) throw new Rejected("generic");
      res.json(await redeem(deps, handoff, sessionId, origin));
    } catch (error) {
      if (error instanceof Rejected) return void reject(res, error.reason);
      // Neither the hand-off nor any token is logged.
      deps.logger.error("Hand-off redemption failed", { error: error instanceof Error ? error.name : "unknown" });
      reject(res, "generic");
    }
  });

  router.post("/sign-out", async (req, res) => {
    const { sessionId } = (req.body ?? {}) as { sessionId?: unknown };
    if (typeof sessionId === "string" && deps.client) {
      try {
        // The grant is revoked locally first; only telling the deployment can fail.
        await deps.client.forSession(sessionId)?.revoke();
      } catch (error) {
        deps.logger.warn("Revoking the attended grant at ImpressoRx failed", { error: error instanceof Error ? error.name : "unknown" });
      }
    }
    res.status(204).end();
  });

  return router;
}

async function redeem(
  deps: HandoffRouterDeps,
  handoff: string,
  sessionId: string,
  origin: unknown,
): Promise<{ identityId: string; membershipId: string }> {
  // `iss` is read from the unverified payload only to pick the registration whose keys verify the message.
  let unverified: { iss?: unknown };
  try {
    unverified = decodeJwt(handoff);
  } catch {
    throw new Rejected("generic");
  }
  const registration = typeof unverified.iss === "string" ? deps.registrations.findByIssuer(unverified.iss) : null;
  if (!registration || registration.status !== "active") throw new Rejected("generic");
  // The browser POSTs from the deployment's own origin (spec 6.1 step 4). Checked before anything is consumed.
  if (typeof origin !== "string" || origin !== registration.origin) throw new Rejected("generic");

  let claims: Record<string, unknown>;
  try {
    ({ payload: claims } = await deps.enrolment.verifyFromDeployment(registration.id, handoff, {
      audience: "oneon",
      maxTtlSeconds: HANDOFF_MAX_TTL_SECONDS,
      consumeJti: (jti, expiresAt) => deps.jti.consume(jti, expiresAt),
    }));
  } catch (error) {
    if (!(error instanceof EnrolmentFailedError)) throw error;
    // "expired" only once the signature has verified; an unauthenticated caller cannot learn anything from it.
    throw new Rejected(error.reason ? "expired" : "generic");
  }

  const sub = claims.sub;
  const role = claims.role;
  if (typeof sub !== "string" || sub.length === 0 || typeof role !== "string" || claims.tenantSlug !== registration.tenantSlug) {
    throw new Rejected("generic");
  }
  if (!deps.client) throw new Rejected("generic");

  // The login is keyed by the deployment and the staff user id; email plays no part (spec §4.3).
  const subject = `${registration.id}:${sub}`;
  let identity = deps.identities.findByLogin("impressorx", subject);
  if (!identity) {
    try {
      identity = deps.identities.createWithLogin({ kind: "impressorx", subject, id: randomUUID() });
    } catch (error) {
      if ((error as { code?: string }).code !== "SQLITE_CONSTRAINT_UNIQUE") throw error;
      identity = deps.identities.findByLogin("impressorx", subject);
    }
  }
  if (!identity || identity.status !== "active") throw new Rejected("membership_suspended");

  const membership = deps.memberships.upsertFromHandoff({
    identityId: identity.id,
    tenantRegistrationId: registration.id,
    externalUserId: sub,
    role,
  });
  if (membership.status === "revoked") throw new Rejected("membership_suspended");

  try {
    ensureIdentityAnchor(deps.openTenant(registration.id), identity.id);
    // The client writes the snapshot through its onSnapshot hook.
    await deps.client.exchangeHandoff(registration.id, handoff, sessionId, identity.id, membership.id, sub);
  } catch (error) {
    // Not idempotent at ImpressoRx: even an unreachable deployment is not retried; the person relaunches.
    if (error instanceof ImpressoRxRefusedError || error instanceof ImpressoRxUnreachableError || error instanceof TenantRefusedError) {
      deps.logger.warn("Hand-off exchange failed", { error: error.name });
      throw new Rejected("generic");
    }
    throw error;
  }

  // A merge can land between finding the identity and storing the grant. The grant was opened for an identity that is no
  // longer the membership's owner (or no longer active): undo it here and at ImpressoRx, and have the person launch again.
  if (deps.identities.findById(identity.id)?.status !== "active" || deps.memberships.findById(membership.id)?.identityId !== identity.id) {
    await deps.client.forSession(sessionId)?.revoke().catch(() => undefined);
    throw new Rejected("generic");
  }
  if (deps.memberships.findById(membership.id)?.status !== "active") {
    await deps.client.forSession(sessionId)?.revoke().catch(() => undefined);
    throw new Rejected("membership_suspended");
  }
  return { identityId: identity.id, membershipId: membership.id };
}
