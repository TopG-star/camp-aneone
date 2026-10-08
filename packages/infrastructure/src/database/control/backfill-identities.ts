import { randomUUID } from "node:crypto";
import type { PersonalDb } from "@oneon/domain";
import { rawDb } from "../context-db-gate.js";
import type { ControlDb } from "./open-control-db.js";

/**
 * Gives every personal user an identity with the same id and a pending Google login whose subject is
 * "email:<email>"; the first sign-in with a `sub` replaces the marker. Returns how many identities it created.
 */
export function backfillIdentities(personal: PersonalDb, control: ControlDb): number {
  const users = rawDb(personal).prepare("SELECT id, email FROM users").all() as Array<{ id: string; email: string }>;
  const exists = control.prepare("SELECT 1 FROM identities WHERE id = ?");
  const insertIdentity = control.prepare("INSERT INTO identities (id, status, created_at) VALUES (?, 'active', ?)");
  const insertLogin = control.prepare(
    "INSERT INTO login_identities (id, identity_id, kind, subject, email, created_at) VALUES (?, ?, 'google', ?, ?, ?)",
  );
  const now = new Date().toISOString();
  return control.transaction(() => {
    let created = 0;
    for (const user of users) {
      if (exists.get(user.id)) continue;
      insertIdentity.run(user.id, now);
      insertLogin.run(randomUUID(), user.id, `email:${user.email}`, user.email, now);
      created += 1;
    }
    return created;
  })();
}
