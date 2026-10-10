// Usage: pnpm --filter @oneon/agent-server restore-backup <file> [--out <path>] [--force]
import { config } from "dotenv";
import { resolve } from "node:path";
import { restoreBackup } from "../src/restore-backup.js";

config({ path: resolve(import.meta.dirname!, "../../..", ".env") });

const key = process.env.BACKUP_ENCRYPTION_KEY;
if (!key) {
  console.error("BACKUP_ENCRYPTION_KEY is not set (it is read from the environment or the repository's .env)");
  process.exit(1);
}
try {
  console.log(`Restored to ${restoreBackup(process.argv.slice(2), key)}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
