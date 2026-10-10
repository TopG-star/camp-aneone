import { Router } from "express";
import type { ConnectionGrantView, ConnectionsView, ReconnectActionView } from "@oneon/contracts";
import type { ContextDb, Logger, TenantDb } from "@oneon/domain";
import type { ImpressoRxClient, MembershipRepository, TenantRegistrationRepository } from "@oneon/infrastructure";
import type { ActionsModule } from "../actions-wiring.js";

export interface ConnectionsRouterDeps {
  /** The sole holder of delegation grants; null while delegation is not configured, when no grants exist. */
  client: Pick<ImpressoRxClient, "listGrantsFor" | "revokeGrantFor"> | null;
  memberships: Pick<MembershipRepository, "listActiveForIdentity">;
  registrations: Pick<TenantRegistrationRepository, "findById">;
  /** Opens a pharmacy's file through the gate; refuses a registration that is not active. */
  openTenant: (registrationId: string) => TenantDb;
  actionsFor: (db: ContextDb) => Pick<ActionsModule, "instanceRepo" | "registry">;
  logger: Logger;
}

const UNKNOWN_PHARMACY = "a pharmacy";
/** Failed actions are read a page at a time, so a pharmacy with many of them is still read whole. */
const PAGE = 100;

/**
 * Settings → Connections: what the signed-in person has let Oneon do at their pharmacies, and the actions that need them to
 * reconnect. Mount after session auth and requireUser, and NOT behind requirePersonalContext: the page is the person's own
 * and works in Personal and from a pharmacy session alike, so a hand-off session can see and revoke its own access.
 *
 * Everything acts on `req.identityId` and nothing else: no identity, pharmacy or grant owner is read from the request. A grant
 * that is not the caller's is a 404, the same as one that does not exist.
 */
export function createConnectionsRouter(deps: ConnectionsRouterDeps): Router {
  const router = Router();

  const pharmacyName = (registrationId: string) => deps.registrations.findById(registrationId)?.displayName ?? UNKNOWN_PHARMACY;

  /** The identity's failed delegation_revoked actions in one pharmacy file. A no_action_grant failure has its own Retry message. */
  function reconnectActions(db: TenantDb, identityId: string, tenantName: string): ReconnectActionView[] {
    const { instanceRepo, registry } = deps.actionsFor(db);
    const found: ReconnectActionView[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = instanceRepo.list(db.tenantId, { statuses: ["failed"], limit: PAGE, offset });
      for (const action of page) {
        if (action.userId !== identityId || action.error?.code !== "delegation_revoked") continue;
        found.push({
          tenantName,
          actionId: action.id,
          label: registry.has(action.actionType) ? registry.get(action.actionType).label : action.actionType,
          failedAt: action.updatedAt,
        });
      }
      if (page.length < PAGE) return found;
    }
  }

  router.get("/", (req, res) => {
    const identityId = req.identityId;
    if (!identityId) return void res.status(401).json({ error: "Authentication required" });
    try {
      const grants: ConnectionGrantView[] = [];
      for (const grant of deps.client?.listGrantsFor(identityId) ?? []) {
        // A revoked grant, or one past its expiry, is not a connection any more.
        if (grant.status !== "active") continue;
        grants.push({
          id: grant.id,
          tenantName: pharmacyName(grant.tenantRegistrationId),
          kind: grant.kind,
          scope: grant.scope,
          createdAt: grant.createdAt,
          lastUsedAt: grant.lastUsedAt,
          expiresAt: grant.expiresAt,
          status: "active",
          current: grant.kind === "attended" && req.sessionId !== undefined && grant.sessionId === req.sessionId,
        });
      }

      // One pharmacy file at a time, each opened through the gate, read and left. A file that will not open (or read) is skipped and
      // named, so the person is not told that nothing needs them when it merely could not be checked.
      const needsReconnect: ReconnectActionView[] = [];
      const unavailable: string[] = [];
      const seen = new Set<string>();
      for (const membership of deps.memberships.listActiveForIdentity(identityId)) {
        const registrationId = membership.tenantRegistrationId;
        if (seen.has(registrationId)) continue;
        seen.add(registrationId);
        const tenantName = pharmacyName(registrationId);
        try {
          needsReconnect.push(...reconnectActions(deps.openTenant(registrationId), identityId, tenantName));
        } catch (error) {
          deps.logger.warn("Connections could not read a pharmacy file", { registrationId, error: error instanceof Error ? error.message : String(error) });
          if (!unavailable.includes(tenantName)) unavailable.push(tenantName);
        }
      }
      needsReconnect.sort((a, b) => b.failedAt.localeCompare(a.failedAt));

      const body: ConnectionsView = { grants, needsReconnect, unavailable };
      res.json(body);
    } catch (error) {
      deps.logger.error("Listing connections failed", { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: "connections_unavailable" });
    }
  });

  router.post("/:grantId/revoke", async (req, res) => {
    const identityId = req.identityId;
    if (!identityId) return void res.status(401).json({ error: "Authentication required" });
    try {
      // Local first, always (the client does that before it asks ImpressoRx), so a revoke never depends on ImpressoRx being up.
      const result = (await deps.client?.revokeGrantFor(identityId, req.params.grantId)) ?? null;
      if (!result) return void res.status(404).json({ error: "grant_not_found" });
      res.json(result);
    } catch (error) {
      deps.logger.error("Revoking a connection failed", { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: "revoke_failed" });
    }
  });

  return router;
}
