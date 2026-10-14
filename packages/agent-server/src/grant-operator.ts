import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PlatformOperatorRepository, acquireStorageLock, backupScratchDir, openControlDbForStartup } from "@oneon/infrastructure";

/**
 * Grants platform operator to an identity. Opening control.db migrates it, so it goes through the same startup path as the server:
 * under the storage lock, with the file sealed into `<backupDir>/pre-migration` first when a migration is pending, and refused when a
 * migration is pending, a registration exists and no key is set.
 */
export async function grantOperator(opts: { controlPath: string; backupDir: string; keyB64: string | undefined; identityId: string }): Promise<void> {
  // Opening a missing path would create a fresh, empty control database (with no identities) instead of finding the server's.
  if (!existsSync(opts.controlPath)) {
    throw new Error(`No control database at ${opts.controlPath}. Set CONTROL_DATABASE_PATH to the server's control.db (the server creates it at its first start).`);
  }
  const release = acquireStorageLock(join(dirname(opts.controlPath), "storage.lock"));
  try {
    const backup = opts.keyB64
      ? { outDir: opts.backupDir, keyB64: opts.keyB64, now: () => new Date(), scratchDir: backupScratchDir(opts.controlPath) }
      : null;
    const control = await openControlDbForStartup(opts.controlPath, backup);
    try {
      if (!control.prepare("SELECT 1 FROM identities WHERE id = ?").get(opts.identityId)) {
        throw new Error(`No identity with id ${opts.identityId}`);
      }
      new PlatformOperatorRepository(control).grant(opts.identityId);
    } finally {
      control.close();
    }
  } finally {
    release();
  }
}

/**
 * The script's paths, from the environment with the server's defaults. A relative path means where the operator typed the command:
 * `pnpm --filter` runs the script in the package folder and sets INIT_CWD to the folder it was typed in.
 */
export function grantOperatorPaths(env: Record<string, string | undefined>, cwd: string = process.cwd()): { controlPath: string; backupDir: string } {
  const base = env.INIT_CWD || cwd;
  return {
    controlPath: resolve(base, env.CONTROL_DATABASE_PATH ?? "./data/control.db"),
    backupDir: resolve(base, env.BACKUP_DIR ?? "./data/backups"),
  };
}
