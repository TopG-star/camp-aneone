import type {
  ActiveContext,
  ActorContext,
  MembershipLike,
  ActionConfigRepository,
  ActionInstanceRepository,
  ContextDb,
  ConversationRepository,
  LegacyActionRepository,
} from "@oneon/domain";
import { personalActor, tenantActor } from "@oneon/domain";
import type { ModelAuditRepository } from "@oneon/application";
import type { MembershipRepository } from "@oneon/infrastructure";
import {
  SqliteActionConfigRepository,
  SqliteActionInstanceRepository,
  SqliteConversationRepository,
  SqliteLegacyActionRepository,
  SqliteModelAuditRepository,
} from "@oneon/infrastructure";

/** The repositories whose rows live per context. Each is bound to one handle and stamps/checks that handle's tenant. */
export interface ContextRepositories {
  conversations: ConversationRepository;
  actionInstances: ActionInstanceRepository;
  actionConfigs: ActionConfigRepository;
  legacyActions: LegacyActionRepository;
  modelAudit: ModelAuditRepository;
}

const memo = new WeakMap<ContextDb, ContextRepositories>();

/** The context-scoped repositories for a handle, built once per handle. Never keep the result beyond the handle's request. */
export function contextRepos(db: ContextDb): ContextRepositories {
  let repos = memo.get(db);
  if (!repos) {
    let legacy: LegacyActionRepository | undefined;
    repos = {
      conversations: new SqliteConversationRepository(db),
      actionInstances: new SqliteActionInstanceRepository(db),
      actionConfigs: new SqliteActionConfigRepository(db),
      // Personal-only: built on first use, and constructing it for a tenant handle throws.
      get legacyActions() {
        return (legacy ??= new SqliteLegacyActionRepository(db));
      },
      modelAudit: new SqliteModelAuditRepository(db),
    };
    memo.set(db, repos);
  }
  return repos;
}

/**
 * The identity's current active membership at the tenant whose rows carry `tenantId` (the registry tenant id).
 * The registration must be active and the membership active; otherwise null.
 */
export function activeMembershipLookup(
  registrations: { findByTenantId(tenantId: string): { id: string } | null },
  memberships: Pick<MembershipRepository, "listActiveForIdentity">,
) {
  return {
    activeFor(identityId: string, tenantId: string) {
      const registration = registrations.findByTenantId(tenantId);
      if (!registration) return null;
      return memberships.listActiveForIdentity(identityId).find((m) => m.tenantRegistrationId === registration.id) ?? null;
    },
  };
}

/** The data scope a context owns rows under: the identity (personal) or the registry tenant id. */
export function ownerOf(ctx: ActiveContext): { scope: "personal" | "tenant"; ownerId: string } {
  return ctx.kind === "personal" ? { scope: "personal", ownerId: ctx.identityId } : { scope: "tenant", ownerId: ctx.tenantId };
}

/** The acting person for a request, from the active context. A tenant actor takes the membership as it is now. */
export function actorForContext(ctx: ActiveContext, memberships: Pick<MembershipRepository, "findById">): ActorContext | null {
  if (ctx.kind === "personal") return personalActor(ctx.identityId);
  const m: (MembershipLike & { status: string }) | null = memberships.findById(ctx.membershipId);
  if (!m || m.status !== "active") return null;
  return tenantActor({ identityId: ctx.identityId, tenantId: ctx.tenantId, role: m.role, permissions: m.permissions, locationIds: m.locationIds });
}
