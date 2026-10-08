import type {
  ActionConfigRepository,
  ActionInstanceRepository,
  ContextDb,
  ConversationRepository,
  LegacyActionRepository,
} from "@oneon/domain";
import type { ModelAuditRepository } from "@oneon/application";
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
