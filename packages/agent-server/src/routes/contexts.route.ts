import { Router, type Request } from "express";
import { z } from "zod";
import type { Logger } from "@oneon/domain";
import type { IdentityRepository, Membership, MembershipRepository, TenantRegistrationRepository } from "@oneon/infrastructure";
import type { SnapshotRefresher } from "../middleware/active-context.js";

export type ContextOption =
  | { kind: "personal" }
  | { kind: "tenant"; membershipId: string; tenantName: string; role: string };

/** What the context picker shows as the current context. */
export type ActiveContextView = ContextOption;

export interface ContextsResponse {
  active: ActiveContextView;
  available: ContextOption[];
}

export interface ContextsRouterDeps {
  memberships: Pick<MembershipRepository, "findById" | "listActiveForIdentity">;
  registrations: Pick<TenantRegistrationRepository, "findById">;
  identities: Pick<IdentityRepository, "hasLogin">;
  snapshots: SnapshotRefresher;
  logger: Logger;
}

const ChoiceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("personal") }),
  z.object({ kind: z.literal("tenant"), membershipId: z.string().min(1) }),
]);

const NOT_AVAILABLE = { error: "context_unavailable", message: "That context isn't available to you." } as const;

/**
 * The context picker's two endpoints (spec §4.4). Mount after session auth and requireUser only: the route reads the
 * session, never a context resolved by resolveActiveContext, so the picker still works when the current context cannot open.
 *
 * What a session may switch to is what the active-context middleware will accept for it:
 * - a hand-off session is bound (by its attended grant) to one membership, so that is the only one it is offered;
 *   it has no personal context here either (the middleware refuses a hand-off session personal data);
 * - a Google session is offered personal and every active membership of its identity.
 */
export function createContextsRouter(deps: ContextsRouterDeps): Router {
  const router = Router();

  const isHandoff = (req: Request) => req.sessionId !== undefined;

  /** The membership as an option, or null when it is not the identity's or its pharmacy is not enrolled and active. */
  function tenantOption(membership: Membership | null, identityId: string, requireActive: boolean): ContextOption | null {
    if (!membership || membership.identityId !== identityId) return null;
    if (requireActive && membership.status !== "active") return null;
    const registration = deps.registrations.findById(membership.tenantRegistrationId);
    if (!registration || (requireActive && registration.status !== "active")) return null;
    return { kind: "tenant", membershipId: membership.id, tenantName: registration.displayName, role: membership.role };
  }

  function available(req: Request, identityId: string): ContextOption[] {
    if (isHandoff(req)) {
      const bound = req.sessionContext ? tenantOption(deps.memberships.findById(req.sessionContext.membershipId), identityId, true) : null;
      return bound ? [bound] : [];
    }
    const options: ContextOption[] = [];
    if (deps.identities.hasLogin(identityId, "google")) options.push({ kind: "personal" });
    for (const membership of deps.memberships.listActiveForIdentity(identityId)) {
      const option = tenantOption(membership, identityId, true);
      if (option) options.push(option);
    }
    return options;
  }

  router.get("/", (req, res) => {
    const identityId = req.identityId;
    if (!identityId) return void res.status(403).json({ error: "context_unavailable" });
    // The session's own choice. A suspended membership is still shown as current, so the person can see where they are and leave it.
    const current = req.sessionContext ? tenantOption(deps.memberships.findById(req.sessionContext.membershipId), identityId, false) : null;
    const active: ActiveContextView | null = current ?? (isHandoff(req) ? null : { kind: "personal" });
    if (!active) return void res.status(403).json({ error: "context_unavailable" });
    const body: ContextsResponse = { active, available: available(req, identityId) };
    res.json(body);
  });

  router.post("/validate", async (req, res) => {
    const identityId = req.identityId;
    const choice = ChoiceSchema.safeParse(req.body);
    if (!choice.success) return void res.status(400).json({ error: "invalid_context" });
    if (!identityId) return void res.status(403).json(NOT_AVAILABLE);
    try {
      const wanted = choice.data;
      const allowed = available(req, identityId).find((o) =>
        wanted.kind === "personal" ? o.kind === "personal" : o.kind === "tenant" && o.membershipId === wanted.membershipId,
      );
      if (!allowed) return void res.status(403).json(NOT_AVAILABLE);
      if (wanted.kind === "tenant") {
        // The same freshness rule as the middleware, so the person is told now rather than after landing in a broken context.
        const membership = deps.memberships.findById(wanted.membershipId)!;
        const fresh = await deps.snapshots.ensureFresh({ sessionId: req.sessionId, membership });
        if (!fresh.ok) return void res.status(403).json(fresh.refusal);
      }
      res.json({ ok: true });
    } catch (error) {
      deps.logger.warn("Context validation failed", { error: error instanceof Error ? error.message : String(error) });
      res.status(403).json(NOT_AVAILABLE);
    }
  });

  return router;
}
