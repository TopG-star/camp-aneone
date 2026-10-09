import type { RequestHandler } from "express";
import type { Logger, PersonalDb, TenantDb } from "@oneon/domain";
import {
  ImpressoRxRefusedError,
  ImpressoRxUnauthorizedError,
  ImpressoRxUnreachableError,
  ensureIdentityAnchor,
  type IdentityRepository,
  type ImpressoRxClient,
  type Membership,
  type MembershipRepository,
  type TenantRegistrationRepository,
} from "@oneon/infrastructure";

const UNAVAILABLE = { error: "context_unavailable" } as const;

/** Spec §6.4. */
const SUSPENDED_MESSAGE = "This pharmacy has switched Oneon off, or your account is inactive.";
/** A snapshot is fresh for 5 minutes (spec §4.6); older than that, it is refreshed before the context opens. */
const SNAPSHOT_MAX_AGE_MS = 300_000;

/** What a hand-off session is told when it reaches a personal-only route. */
const PERSONAL_UNAVAILABLE_FROM_PHARMACY = {
  error: "personal_context_required",
  message: "Personal isn't available when you open Oneon from a pharmacy. Sign in with Google to use it.",
} as const;

/** Why a tenant context cannot open right now; sent as the 403 body. */
export type ContextRefusal =
  | { error: "launch_required" | "membership_suspended"; message: string }
  | typeof UNAVAILABLE;
export const LAUNCH_REQUIRED: ContextRefusal = {
  error: "launch_required",
  message: "Your pharmacy details are out of date. Open Oneon from ImpressoRx again to continue.",
};
export const SUSPENDED: ContextRefusal = { error: "membership_suspended", message: SUSPENDED_MESSAGE };
/** The 503 body when a decision needs a live answer from ImpressoRx and it cannot be reached. */
export const IMPRESSORX_UNREACHABLE = {
  error: "impressorx_unreachable",
  message: "Oneon can't reach ImpressoRx right now, so it can't check your access. Nothing was changed. Try again in a moment.",
} as const;

export type RefreshResult = { ok: true } | { ok: false; refusal: ContextRefusal };
const OK: RefreshResult = { ok: true };

/** After ImpressoRx cannot be reached, the cached snapshot is used and no new refresh is tried for this long. */
const UNREACHABLE_COOLDOWN_MS = 30_000;

export type LiveResult =
  | { ok: true; membership: Membership }
  | { ok: false; reason: "membership_suspended" | "launch_required" | "impressorx_unreachable" };

export interface SnapshotRefresher {
  /** Resolves ok when the membership's snapshot is fresh (refreshing it first when it is older than 5 minutes). */
  ensureFresh(input: { sessionId: string | undefined; membership: Membership }): Promise<RefreshResult>;
  /**
   * Spec §9.3: asks ImpressoRx now, however fresh the stored snapshot is, and answers with the membership as the snapshot left it.
   * Classified exactly like ensureFresh (only ImpressoRx's own 401 suspends; any other refusal is launch_required and changes nothing),
   * except that an unreachable ImpressoRx is the answer here: a decision needs the live snapshot, not the cached one, and no cooldown applies.
   */
  checkLive(input: { sessionId: string | undefined; membership: Pick<Membership, "id" | "identityId"> }): Promise<LiveResult>;
}

export interface SnapshotRefresherDeps {
  memberships: Pick<MembershipRepository, "findById" | "setStatus">;
  registrations: Pick<TenantRegistrationRepository, "findById">;
  /** The ImpressoRx client; null when delegation is not configured, and a stale snapshot then needs a relaunch. */
  client: {
    forBoundSession: (sessionId: string, identityId: string, membershipId: string) => { me(): Promise<unknown> } | null;
    revokeForMembership: ImpressoRxClient["revokeForMembership"];
  } | null;
  logger: Logger;
  clock?: () => Date;
}

/**
 * Keeps a tenant membership's snapshot at most 5 minutes old (spec §4.6) by calling GET /api/oneon/me through the
 * attended grant bound to this session, identity and membership (the client writes the snapshot). The snapshot only
 * offers and refuses early, so:
 * - ImpressoRx answered 401 (ImpressoRxUnauthorizedError, the contract's only refusal): the membership is suspended and
 *   every grant of it revoked locally. Nothing else suspends: a refusal made here (a grant expired or revoked locally) or an
 *   unexpected status (404, 400, 3xx) is ImpressoRx's malfunction or ours, not its word, so it is launch_required, logged
 *   with its status or reason, with no side effects.
 * - ImpressoRx unreachable: keep the cached snapshot and carry on (logged at warn), and do not try again for 30 s.
 * - A registration that is not active is the gate's own refusal (context_unavailable), before anything is sent.
 * - No usable bound grant in this session (a Google session on a linked membership, or an expired grant): launch_required.
 * Refresh is single-flight per membership in this process: two concurrent exchanges of one grant value are theft at ImpressoRx.
 */
export function createSnapshotRefresher(deps: SnapshotRefresherDeps): SnapshotRefresher {
  const clock = deps.clock ?? (() => new Date());
  const inflight = new Map<string, Promise<RefreshResult>>();
  const cooldownUntil = new Map<string, number>();

  const suspend = (membership: Pick<Membership, "id">, why: string): RefreshResult => {
    if (deps.memberships.findById(membership.id)?.status === "active") deps.memberships.setStatus(membership.id, "suspended");
    deps.client?.revokeForMembership(membership.id, "membership_suspended");
    deps.logger.warn("Membership suspended", { membershipId: membership.id, why });
    return { ok: false, refusal: SUSPENDED };
  };

  /**
   * Why a me() call failed, with the side effect each kind has (one classification for the refresh and the live check): only
   * ImpressoRx's own 401 suspends the membership; any other refusal (a local one, an unexpected status) changes nothing.
   */
  function classifyFailure(membership: Pick<Membership, "id">, error: unknown): "unreachable" | "suspended" | "refused" {
    if (error instanceof ImpressoRxUnreachableError) return "unreachable";
    if (error instanceof ImpressoRxUnauthorizedError) {
      suspend(membership, "unauthorized");
      return "suspended";
    }
    if (error instanceof ImpressoRxRefusedError) {
      deps.logger.warn("Membership snapshot refresh refused without a 401; keeping the membership", {
        membershipId: membership.id,
        status: error.status,
        reason: error.message,
      });
      return "refused";
    }
    throw error;
  }

  async function refresh(membership: Membership, calls: { me(): Promise<unknown> }): Promise<RefreshResult> {
    try {
      await calls.me();
    } catch (error) {
      const failure = classifyFailure(membership, error);
      if (failure === "unreachable") {
        cooldownUntil.set(membership.id, clock().getTime() + UNREACHABLE_COOLDOWN_MS);
        deps.logger.warn("ImpressoRx unreachable; keeping the cached membership snapshot", { membershipId: membership.id });
        return OK;
      }
      return { ok: false, refusal: failure === "suspended" ? SUSPENDED : LAUNCH_REQUIRED };
    }
    // The snapshot was written by the client; it may say the tenant is no longer serviceable.
    return deps.memberships.findById(membership.id)?.status === "active" ? OK : suspend(membership, "snapshot");
  }

  return {
    async checkLive({ sessionId, membership }) {
      const calls = sessionId && deps.client ? deps.client.forBoundSession(sessionId, membership.identityId, membership.id) : null;
      if (!calls) return { ok: false, reason: "launch_required" };
      try {
        await calls.me();
      } catch (error) {
        const failure = classifyFailure(membership, error);
        if (failure === "unreachable") {
          deps.logger.warn("ImpressoRx unreachable; the live membership check could not be made", { membershipId: membership.id });
          return { ok: false, reason: "impressorx_unreachable" };
        }
        return { ok: false, reason: failure === "suspended" ? "membership_suspended" : "launch_required" };
      }
      // The client wrote the snapshot just now; it may say the tenant is no longer serviceable.
      const fresh = deps.memberships.findById(membership.id);
      if (fresh?.status !== "active") {
        suspend(membership, "snapshot");
        return { ok: false, reason: "membership_suspended" };
      }
      return { ok: true, membership: fresh };
    },
    async ensureFresh({ sessionId, membership }) {
      // NaN (an unreadable time) counts as stale.
      if (clock().getTime() - Date.parse(membership.snapshotAt) <= SNAPSHOT_MAX_AGE_MS) return OK;
      // The gate refuses a registration that is not active; say so now, without asking ImpressoRx or changing anything.
      if (deps.registrations.findById(membership.tenantRegistrationId)?.status !== "active") {
        deps.logger.warn("Membership snapshot not refreshed: the registration is not active", { membershipId: membership.id });
        return { ok: false, refusal: UNAVAILABLE };
      }
      const calls = sessionId && deps.client ? deps.client.forBoundSession(sessionId, membership.identityId, membership.id) : null;
      if (!calls) return { ok: false, refusal: LAUNCH_REQUIRED };
      if ((cooldownUntil.get(membership.id) ?? 0) > clock().getTime()) return OK;
      cooldownUntil.delete(membership.id);
      let flight = inflight.get(membership.id);
      if (!flight) {
        flight = refresh(membership, calls).finally(() => inflight.delete(membership.id));
        inflight.set(membership.id, flight);
      }
      return flight;
    },
  };
}

export interface ActiveContextDeps {
  gate: { openPersonal(): PersonalDb; openTenant(registrationId: string): TenantDb };
  memberships: Pick<MembershipRepository, "findById">;
  identities: Pick<IdentityRepository, "hasLogin">;
  snapshots: SnapshotRefresher;
  logger: Logger;
}

/**
 * Resolves the request's one active context and opens its database (spec §8.2). The context comes only from the
 * session (never from the request body, query or path): a hand-off session names a membership, a Google session is
 * personal unless the person chose a pharmacy. A tenant needs an active membership owned by the signed-in identity, a
 * snapshot no older than 5 minutes (refreshed here when it is) and an openable file; personal needs a Google login.
 * A suspended membership, or one ImpressoRx refuses with a 401, is 403 membership_suspended with the spec §6.4 message; a stale
 * snapshot that cannot be refreshed from this session is 403 launch_required. Anything else, including a gate refusal
 * or an unexpected error, is 403 context_unavailable.
 * Mount after session auth and requireUser; the handle is valid for this request only.
 */
export function resolveActiveContext(deps: ActiveContextDeps): RequestHandler {
  return async (req, res, next) => {
    try {
      const identityId = req.identityId;
      if (!identityId) {
        res.status(403).json(UNAVAILABLE);
        return;
      }
      const session = req.sessionContext;
      if (session) {
        const membership = deps.memberships.findById(session.membershipId);
        if (membership && membership.identityId === identityId && membership.status === "suspended") {
          res.status(403).json(SUSPENDED);
          return;
        }
        if (!membership || membership.status !== "active" || membership.identityId !== identityId) {
          res.status(403).json(UNAVAILABLE);
          return;
        }
        const fresh = await deps.snapshots.ensureFresh({ sessionId: req.sessionId, membership });
        if (!fresh.ok) {
          res.status(403).json(fresh.refusal);
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
 * The answer is 403 personal_context_required: the session works in a pharmacy, and the dashboard shows that instead of
 * sending the person to sign in. A Google session that chose a pharmacy can switch to Personal (the dashboard's default
 * message says so). A hand-off session never gets Personal, so it is told what will: sign in with Google.
 */
export const requirePersonalContext: RequestHandler = (req, res, next) => {
  if (req.sessionContext || req.sessionId) {
    res.status(403).json(req.sessionId ? PERSONAL_UNAVAILABLE_FROM_PHARMACY : { error: "personal_context_required" });
    return;
  }
  next();
};
