import { dirname, join } from "node:path";
import { PlatformOperatorRepository, acquireStorageLock, backupScratchDir, openControlDbForStartup } from "@oneon/infrastructure";

/**
 * Grants platform operator to an identity. Opening control.db migrates it, so it goes through the same startup path as the server:
 * under the storage lock, with the file sealed into `<backupDir>/pre-migration` first when a migration is pending, and refused when a
 * migration is pending, a registration exists and no key is set.
 */
export async function grantOperator(opts: { controlPath: string; backupDir: string; keyB64: string | undefined; identityId: string }): Promise<void> {
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
