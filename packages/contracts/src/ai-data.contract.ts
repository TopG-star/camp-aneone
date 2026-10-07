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
