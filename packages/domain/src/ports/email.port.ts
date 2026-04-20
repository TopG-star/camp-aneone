import type { InboundItem } from "../entities.js";

/**
 * Port for ingesting messages from external sources.
 * Each source (Gmail, Outlook/PA, Teams/PA, GitHub) implements this.
 */
export interface IngestionPort {
  fetchNew(
    userId: string,
  ): Promise<
    Omit<InboundItem, "id" | "createdAt" | "updatedAt" | "classifiedAt">[]
  >;
}

/** @deprecated Use IngestionPort instead */
export type EmailPort = IngestionPort;
