import type { PersonalDb } from "@oneon/domain";
import { rawDb } from "../context-db-gate.js";
import { ensureIdentityForUser } from "./ensure-identity.js";
import type { ControlDb } from "./open-control-db.js";

/** Gives every personal user an identity (see ensureIdentityForUser). Returns how many it created. */
export function backfillIdentities(personal: PersonalDb, control: ControlDb): number {
  const users = rawDb(personal).prepare("SELECT id, email FROM users").all() as Array<{ id: string; email: string }>;
  return control.transaction(() => users.filter((user) => ensureIdentityForUser(control, user)).length)();
}
