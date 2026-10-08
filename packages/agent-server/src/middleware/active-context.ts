import type { RequestHandler } from "express";
import type { Logger, PersonalDb, TenantDb } from "@oneon/domain";
import { ensureIdentityAnchor, type IdentityRepository, type MembershipRepository } from "@oneon/infrastructure";

const UNAVAILABLE = { error: "context_unavailable" } as const;

export interface ActiveContextDeps {
  gate: { openPersonal(): PersonalDb; openTenant(registrationId: string): TenantDb };
  memberships: Pick<MembershipRepository, "findById">;
  identities: Pick<IdentityRepository, "hasLogin">;
  logger: Logger;
}

/**
 * Resolves the request's one active context and opens its database (spec §8.2). The context comes only from the
 * session (never from the request body, query or path): a hand-off session names a membership, a Google session is
 * personal. A tenant needs an active membership owned by the signed-in identity and an openable file; personal needs
 * a Google login. Anything else, including a gate refusal or an unexpected error, is 403 context_unavailable.
 * Mount after session auth and requireUser; the handle is valid for this request only.
 */
export function resolveActiveContext(deps: ActiveContextDeps): RequestHandler {
  return (req, res, next) => {
    try {
      const identityId = req.identityId;
      if (!identityId) {
        res.status(403).json(UNAVAILABLE);
        return;
      }
      const session = req.sessionContext;
      if (session) {
        const membership = deps.memberships.findById(session.membershipId);
        if (!membership || membership.status !== "active" || membership.identityId !== identityId) {
          res.status(403).json(UNAVAILABLE);
          return;
        }
        const db = deps.gate.openTenant(membership.tenantRegistrationId);
        // The file's foreign keys reference users(id), so the identity needs its anchor row before it writes here.
        ensureIdentityAnchor(db, identityId);
        req.activeContext = { kind: "tenant", identityId, membershipId: membership.id, registrationId: membership.tenantRegistrationId, tenantId: db.tenantId };
        req.contextDb = db;
        next();
        return;
      }
      if (req.sessionId || !deps.identities.hasLogin(identityId, "google")) {
        res.status(403).json(UNAVAILABLE);
        return;
      }
      req.activeContext = { kind: "personal", identityId };
      req.contextDb = deps.gate.openPersonal();
      next();
    } catch (error) {
      // Operators need the cause (gate refusal, locked file, a bug); the client only ever sees context_unavailable.
      deps.logger.warn("Active context unavailable", {
        error: error instanceof Error ? (error as { code?: string }).code ?? error.message : String(error),
        membershipId: req.sessionContext?.membershipId,
      });
      res.status(403).json(UNAVAILABLE);
    }
  };
}

/**
 * Guards every route that is not context-aware. A hand-off identity has no personal data and must never reach the
 * personal repositories, so a hand-off session is refused here. This is the default chain for browser routes
 * (userAuth); only a route that resolves its own context may use another chain, so a route added later is
 * personal-only until it opts in. Requests without a session pass, for the route's own auth to answer.
 */
export const requirePersonalContext: RequestHandler = (req, res, next) => {
  if (req.sessionContext || req.sessionId) {
    res.status(403).json(UNAVAILABLE);
    return;
  }
  next();
};
