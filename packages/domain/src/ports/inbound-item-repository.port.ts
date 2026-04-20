import type { InboundItem } from "../entities.js";
import type { Source } from "../enums.js";

export interface InboundItemRepository {
  upsert(item: Omit<InboundItem, "id" | "createdAt" | "updatedAt">): InboundItem;
  findById(id: string): InboundItem | null;
  findBySourceAndExternalId(source: Source, externalId: string, userId?: string): InboundItem | null;
  findUnclassified(limit: number, userId?: string): InboundItem[];
  findAll(options: {
    source?: Source;
    since?: string;
    limit?: number;
    offset?: number;
    userId?: string;
  }): InboundItem[];
  search(options: {
    query: string;
    source?: Source;
    limit?: number;
    userId?: string;
  }): InboundItem[];
  markClassified(id: string): void;
  incrementClassifyAttempts(id: string): void;
  count(options?: { source?: Source; since?: string; userId?: string }): number;
}
