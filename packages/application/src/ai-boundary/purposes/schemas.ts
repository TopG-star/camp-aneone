import { z } from "zod";

export const classificationSchema = z.object({
  category: z.enum(["urgent", "work", "personal", "newsletter", "transactional", "spam"]),
  priority: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  summary: z.string().min(1).max(500),
  actionItems: z.array(z.string()),
  followUpNeeded: z.boolean(),
  deadlines: z.array(z.object({ dueDate: z.string(), description: z.string(), confidence: z.number().min(0).max(1) })),
});
export type ClassificationOutput = z.infer<typeof classificationSchema>;

export const intentSchema = z.array(z.object({ tool: z.string().min(1), parameters: z.record(z.unknown()) }));
export type IntentOutput = z.infer<typeof intentSchema>;

export const synthesisResponseSchema = z.object({
  answer: z.string().min(1),
  followUps: z.array(z.string()).optional().default([]),
  usedTools: z.array(z.string()),
  warnings: z.array(z.string()).optional().default([]),
});
export type SynthesisResponse = z.infer<typeof synthesisResponseSchema>;
