import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ControlDb } from "./open-control-db.js";

/** An intent lives 5 minutes (spec §4.5). */
const TTL_MS = 5 * 60 * 1000;

const bindingHash = (secret: string) => createHash("sha256").update(secret).digest("hex");

/**
 * Link intents (spec §4.5): opened by a signed-in identity, spent by the second sign-in of the same browser. Each is bound to
 * a random secret of 32 bytes that is handed out once; only its SHA-256 is stored, so the table alone cannot spend an intent.
 */
export class LinkIntentRepository {
  constructor(
    private readonly db: ControlDb,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  create(identityId: string): { id: string; secret: string } {
    const id = randomUUID();
    const secret = randomBytes(32).toString("base64url");
    const expiresAt = new Date(this.clock().getTime() + TTL_MS).toISOString();
    this.db
      .prepare("INSERT INTO link_intents (id, binding_hash, identity_id, expires_at, used_at) VALUES (?, ?, ?, ?, NULL)")
      .run(id, bindingHash(secret), identityId, expiresAt);
    return { id, secret };
  }

  /**
   * The identity that opened the intent when it could still be spent right now (same checks as consume), or null. Reads only:
   * it is how a preview validates an intent without using it up.
   */
  peek(id: string, secret: string): string | null {
    const row = this.db
      .prepare("SELECT identity_id FROM link_intents WHERE id = ? AND binding_hash = ? AND used_at IS NULL AND expires_at > ?")
      .get(id, bindingHash(secret), this.clock().toISOString()) as { identity_id: string } | undefined;
    return row?.identity_id ?? null;
  }

  /**
   * Spends the intent and returns the identity that opened it, or null when it does not exist, has expired, was spent
   * already, or the secret does not match. It is one conditional UPDATE, so of any number of concurrent attempts, in this
   * process or another, exactly one wins. A wrong secret changes nothing: it cannot burn the intent of the real holder.
   */
  consume(id: string, secret: string): string | null {
    const now = this.clock().toISOString();
    const row = this.db
      .prepare(
        `UPDATE link_intents SET used_at = ?
          WHERE id = ? AND binding_hash = ? AND used_at IS NULL AND expires_at > ?
          RETURNING identity_id`,
      )
      .get(now, id, bindingHash(secret), now) as { identity_id: string } | undefined;
    return row?.identity_id ?? null;
  }
}
