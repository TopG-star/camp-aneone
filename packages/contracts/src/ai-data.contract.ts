import { z } from "zod";

const ProviderIdSchema = z.enum(["deepseek", "anthropic"]);
const DataClassSchema = z.enum(["D0", "D1", "D2", "D3", "D4"]);

export const AiDataProviderViewSchema = z.object({
  id: ProviderIdSchema,
  label: z.string(),
  review: z.enum(["unreviewed", "reviewed"]),
  limits: z.object({ personal: DataClassSchema, tenant: DataClassSchema }),
  override: z.string().nullable(),
  configured: z.boolean(),
  personalChoice: z.enum(["D1", "D2"]),
  choiceConfirmedAt: z.string().nullable(),
});

export const AiDataCallViewSchema = z.object({
  callId: z.string(),
  at: z.string(),
  purpose: z.string(),
  channel: z.string().nullable(),
  provider: z.string(),
  decision: z.enum(["allow", "deny"]),
  effectiveLimit: DataClassSchema.nullable(),
  denyReason: z.string().nullable(),
  withheldCount: z.number().int(),
  alert: z.boolean(),
  outcome: z.enum(["answered", "blocked", "failed"]).nullable(),
});

export const AiDataViewSchema = z.object({
  providers: z.array(AiDataProviderViewSchema),
  pendingDecision: z.object({ provider: ProviderIdSchema, maxClass: z.literal("D2"), decidedOn: z.string(), note: z.string() }).nullable(),
  emailClassification: z.object({ active: z.boolean(), reason: z.string().nullable() }),
  routingWarnings: z.array(z.object({ role: z.enum(["standard", "reasoning", "shadow"]), provider: ProviderIdSchema })),
  recent: z.array(AiDataCallViewSchema),
});
export type AiDataView = z.infer<typeof AiDataViewSchema>;

export const AiDataChoiceWriteSchema = z.object({ provider: ProviderIdSchema, maxClass: z.enum(["D1", "D2"]) }).strict();

// Settings → AI data in a pharmacy (Step B-core, spec 9.4): the pharmacy's own limit, shown to everyone in it. A row names no one and
// carries neither its live check nor its evidence; `byYou` is all the page needs of who set it.
const TenantLimitClassSchema = z.enum(["D0", "D1", "D2"]);

export const TenantAiLimitVersionViewSchema = z.object({
  id: z.string(),
  maxClass: TenantLimitClassSchema,
  at: z.string(),
  byYou: z.boolean(),
});

export const TenantAiLimitViewSchema = z.object({
  current: TenantLimitClassSchema,
  /** Newest first. Empty while the pharmacy is on the default. */
  history: z.array(TenantAiLimitVersionViewSchema),
  /** From the cached snapshot, only to decide whether to show the control. The server checks again, live, on every change. */
  canChange: z.boolean(),
});
export type TenantAiLimitView = z.infer<typeof TenantAiLimitViewSchema>;

/**
 * D3 and D4 parse here and are refused by the route with their own error, because they are never allowed (spec 9.4).
 * `expectedCurrent` is the class the page showed; the change is refused if the limit is no longer that.
 */
export const TenantAiLimitWriteSchema = z.object({ maxClass: DataClassSchema, expectedCurrent: TenantLimitClassSchema.optional() }).strict();
