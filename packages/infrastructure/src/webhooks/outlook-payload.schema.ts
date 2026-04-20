import { z } from "zod";

/**
 * Schema for the Outlook email payload sent by Power Automate.
 * Maps to the Microsoft Graph Mail Resource shape that PA exposes.
 */
export const outlookPayloadSchema = z.object({
  id: z.string().min(1),
  from: z.union([
    z.string().min(1),
    z.object({
      emailAddress: z.object({
        name: z.string().optional(),
        address: z.string().min(1),
      }),
    }),
  ]),
  subject: z.string().default("(no subject)"),
  bodyPreview: z.string().default(""),
  body: z
    .object({
      content: z.string(),
      contentType: z.string().optional(),
    })
    .optional(),
  receivedDateTime: z.string().min(1),
  conversationId: z.string().nullable().optional(),
  categories: z.array(z.string()).default([]),
});

export type OutlookPayload = z.infer<typeof outlookPayloadSchema>;

/**
 * Extract the sender email string from the PA payload's `from` field.
 * Power Automate may send it as a plain string or Graph-style object.
 */
export function extractSenderEmail(
  from: OutlookPayload["from"]
): string {
  if (typeof from === "string") return from;
  return from.emailAddress.address;
}
