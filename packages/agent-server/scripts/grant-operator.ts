// Usage: pnpm --filter @oneon/agent-server grant-operator <identityId>
import { config } from "dotenv";
import { resolve } from "node:path";
import { grantOperator } from "../src/grant-operator.js";

config({ path: resolve(import.meta.dirname!, "../../..", ".env") });

const identityId = process.argv[2];
if (!identityId) {
  console.error("Usage: grant-operator <identityId>");
  process.exit(1);
}

try {
  await grantOperator({
    controlPath: process.env.CONTROL_DATABASE_PATH ?? "./data/control.db",
    backupDir: process.env.BACKUP_DIR ?? "./data/backups",
    keyB64: process.env.BACKUP_ENCRYPTION_KEY || undefined,
    identityId,
  });
  console.log(`Granted platform operator to ${identityId}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
