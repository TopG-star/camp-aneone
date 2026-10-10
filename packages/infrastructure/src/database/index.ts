export { createDatabase, runMigrations, latestMigrationVersion, hasPendingMigrations } from "./connection.js";
export { ContextDbGate, TenantRefusedError, rawDb, ensureIdentityAnchor } from "./context-db-gate.js";
export { migrateAll } from "./migrate-all.js";
export { backupAll, restoreTest, decryptBackup, type BackupResult, type RestoreTestResult, type PreMigrationBackup } from "./backup.js";
export { openControlDb, openControlDbForStartup, hasRegistrations, type ControlDb } from "./control/open-control-db.js";
export { SqliteTransactionRunner } from "./transaction-runner.js";
export * from "./repositories/index.js";
export { runActionDriftCheck } from "./action-drift-check.js";
export { SqliteIdentityRepository, LinkUnavailableError, UnlinkRefusedError, type IdentityRepository, type Identity, type Membership, type LoginKind, type LoginSummary, type UnlinkRefusal } from "./control/identity-repository.js";
export { LinkIntentRepository } from "./control/link-intent-repository.js";
export { backfillIdentities } from "./control/backfill-identities.js";
export { ensureIdentityForUser } from "./control/ensure-identity.js";
export { TenantRegistrationRepository, KEY_OVERLAP_MS, type TenantRegistration, type TenantRegistrationStatus, type OneonKey, type DeploymentKey, type CreateTenantRegistrationInput } from "./control/tenant-registration-repository.js";
export { PlatformOperatorRepository } from "./control/platform-operator-repository.js";
export { MembershipRepository, type SnapshotFields } from "./control/membership-repository.js";
export {
  TenantAiLimitRepository,
  DEFAULT_TENANT_LIMIT,
  type TenantAiLimitVersion,
  type NewTenantAiLimitVersion,
  type TenantLimitChange,
  type TenantLimitClass,
} from "./control/tenant-ai-limit-repository.js";
export { UsedHandoffJti } from "./control/used-handoff-jti.js";
