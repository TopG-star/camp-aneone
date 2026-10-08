// Usage: pnpm --filter @oneon/agent-server grant-operator <identityId>
import { config } from "dotenv";
import { resolve } from "node:path";
import { PlatformOperatorRepository, openControlDb } from "@oneon/infrastructure";

config({ path: resolve(import.meta.dirname!, "../../..", ".env") });

const identityId = process.argv[2];
if (!identityId) {
  console.error("Usage: grant-operator <identityId>");
  process.exit(1);
}

const control = openControlDb(process.env.CONTROL_DATABASE_PATH ?? "./data/control.db");
try {
  if (!control.prepare("SELECT 1 FROM identities WHERE id = ?").get(identityId)) {
    console.error(`No identity with id ${identityId}`);
    process.exit(1);
  }
  new PlatformOperatorRepository(control).grant(identityId);
  console.log(`Granted platform operator to ${identityId}`);
} finally {
  control.close();
}
