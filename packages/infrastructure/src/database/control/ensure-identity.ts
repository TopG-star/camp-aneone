import { randomUUID } from "node:crypto";
import type { ControlDb } from "./open-control-db.js";

/**
 * Makes sure a personal user has an identity (id = users.id) with a pending Google login whose subject is
 * "email:<email>". Idempotent. Returns true when it created the identity.
 */
export function ensureIdentityForUser(control: ControlDb, user: { id: string; email: string }): boolean {
  return control.transaction((): boolean => {
    if (control.prepare("SELECT 1 FROM identities WHERE id = ?").get(user.id)) return false;
    const now = new Date().toISOString();
    control.prepare("INSERT INTO identities (id, status, created_at) VALUES (?, 'active', ?)").run(user.id, now);
    control
      .prepare("INSERT INTO login_identities (id, identity_id, kind, subject, email, created_at) VALUES (?, ?, 'google', ?, ?, ?)")
      .run(randomUUID(), user.id, `email:${user.email}`, user.email, now);
    return true;
  })();
}
