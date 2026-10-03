import type { EntityRef } from "./types.js";

export const KNOWN_ENTITY_TYPES = ["PERSON", "CUSTOMER", "SUPPLIER"] as const;
export const TOKEN_PATTERN = new RegExp(`\\b(?:${KNOWN_ENTITY_TYPES.join("|")})_\\d+\\b`, "g");

/** One turn's mapping between real entities and placeholders. In memory only; never logged (spec §7.1). */
export class PlaceholderMap {
  private readonly byEntity = new Map<string, string>();
  private readonly byToken = new Map<string, { entity: EntityRef; display: string }>();
  private readonly counters = new Map<string, number>();

  tokenFor(entity: EntityRef, display: string): string {
    const prefix = entity.type.toUpperCase();
    if (!(KNOWN_ENTITY_TYPES as readonly string[]).includes(prefix)) throw new Error(`Unknown entity type "${entity.type}"`);
    const key = `${prefix}:${entity.id}`;
    const existing = this.byEntity.get(key);
    if (existing) return existing;
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    const token = `${prefix}_${n}`;
    this.byEntity.set(key, token);
    this.byToken.set(token, { entity, display });
    return token;
  }

  lookup(token: string): { entity: EntityRef; display: string } | null {
    return this.byToken.get(token) ?? null;
  }

  displays(): string[] {
    return [...this.byToken.values()].map((v) => v.display);
  }

  get size(): number {
    return this.byToken.size;
  }
}
