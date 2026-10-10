import { existsSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { decryptBackup } from "@oneon/infrastructure";

const USAGE = "Usage: pnpm --filter @oneon/agent-server restore-backup <file> [--out <path>] [--force]";

/**
 * Decrypts one backup file to an output path and returns that path. Refuses to overwrite an existing file unless `--force` is given,
 * so a restore never replaces a live database by accident: stop the server, restore, then move the file into place.
 */
export function restoreBackup(argv: string[], keyB64: string): string {
  let file: string | undefined;
  let out: string | undefined;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--force") force = true;
    else if (arg === "--out") out = argv[++i];
    else if (arg.startsWith("--")) throw new Error(`Unknown option ${arg}. ${USAGE}`);
    else file = arg;
  }
  if (!file || (argv.includes("--out") && !out)) throw new Error(USAGE);

  // The default is the current directory, never the backup folder: that folder is what gets synced off-site, and this output is plaintext.
  const target = resolve(out ?? basename(file).replace(/\.enc$/, ""));
  if (existsSync(target) && !force) throw new Error(`${target} already exists; choose another --out, or pass --force to overwrite it`);

  let database: Buffer;
  try {
    database = decryptBackup(resolve(file), keyB64);
  } catch (error) {
    throw new Error(
      `Cannot decrypt ${file}: wrong BACKUP_ENCRYPTION_KEY, a damaged file, or the file is not in its original folder and file name (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  writeFileSync(target, database, { mode: 0o600, flag: force ? "w" : "wx" });
  return target;
}
