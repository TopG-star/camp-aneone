import type { ControlDb } from "./open-control-db.js";

/** Single-use record of hand-off ids (`used_handoff_jti`). A row outlives the hand-off's last accepted moment. */
export class UsedHandoffJti {
  constructor(
    private readonly db: ControlDb,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** True the first time a jti is seen; false for a replay. */
  consume(jti: string, expiresAt: string): boolean {
    const now = this.clock().toISOString();
    // Expired rows can no longer be replayed (the signature check rejects the message first), so they are dropped.
    this.db.prepare("DELETE FROM used_handoff_jti WHERE expires_at < ?").run(now);
    const result = this.db.prepare("INSERT OR IGNORE INTO used_handoff_jti (jti, expires_at, used_at) VALUES (?, ?, ?)").run(jti, expiresAt, now);
    return result.changes === 1;
  }
}
