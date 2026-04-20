import { z } from "zod";

// ── Offset-based pagination (MVP) ────────────────────────────

export const OffsetPaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

export type OffsetPaginationQuery = z.infer<typeof OffsetPaginationQuerySchema>;

export const OffsetPaginationMetaSchema = z.object({
  limit: z.number(),
  offset: z.number(),
  total: z.number(),
  hasMore: z.boolean(),
});

export type OffsetPaginationMeta = z.infer<typeof OffsetPaginationMetaSchema>;
