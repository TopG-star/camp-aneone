import { randomUUID } from "node:crypto";
import type { ControlDb } from "./open-control-db.js";

export class PlatformOperatorRepository {
  constructor(private readonly db: ControlDb) {}

  /** The table is append-only; the latest row for an identity decides. */
  isOperator(identityId: string): boolean {
    const row = this.db
      .prepare("SELECT action FROM platform_operators WHERE identity_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(identityId) as { action: "grant" | "remove" } | undefined;
    return row?.action === "grant";
  }

  grant(identityId: string, actorId: string | null = null): void {
    this.append(identityId, "grant", actorId);
  }

  remove(identityId: string, actorId: string | null = null): void {
    this.append(identityId, "remove", actorId);
  }

  private append(identityId: string, action: "grant" | "remove", actorId: string | null): void {
    this.db
      .prepare("INSERT INTO platform_operators (id, identity_id, action, actor_id, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(randomUUID(), identityId, action, actorId, new Date().toISOString());
  }
}
