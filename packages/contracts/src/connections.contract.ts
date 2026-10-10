import { z } from "zod";

// Settings → Connections (Step B-core): what a person has let Oneon do at their pharmacies, and the logins that make up
// their account. Nothing here can open a connection: no grant value, no session id, no staff id.

export const ConnectionGrantViewSchema = z.object({
  id: z.string(),
  tenantName: z.string(),
  kind: z.enum(["attended", "action", "schedule"]),
  scope: z.array(z.string()),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  /** The sooner of the idle and the absolute expiry: when this connection ends if nobody uses it. */
  expiresAt: z.string(),
  /** Only live connections are listed. */
  status: z.literal("active"),
  /** The connection this very session is signed in with. Revoking it signs the person out of that pharmacy. */
  current: z.boolean(),
});
export type ConnectionGrantView = z.infer<typeof ConnectionGrantViewSchema>;

/** A failed action that can only run again after the person opens Oneon from ImpressoRx. */
export const ReconnectActionViewSchema = z.object({
  tenantName: z.string(),
  actionId: z.string(),
  label: z.string(),
  failedAt: z.string(),
});
export type ReconnectActionView = z.infer<typeof ReconnectActionViewSchema>;

export const ConnectionsViewSchema = z.object({
  grants: z.array(ConnectionGrantViewSchema),
  needsReconnect: z.array(ReconnectActionViewSchema),
  /** Pharmacies whose actions could not be checked right now, by name. */
  unavailable: z.array(z.string()),
});
export type ConnectionsView = z.infer<typeof ConnectionsViewSchema>;

/** `unreachable`: revoked in Oneon, but ImpressoRx did not confirm, so the connection lives there until it expires. */
export const RevokeConnectionResultSchema = z.object({ remote: z.enum(["revoked", "unreachable"]) });
export type RevokeConnectionResult = z.infer<typeof RevokeConnectionResultSchema>;

export const LinkedLoginViewSchema = z.object({
  id: z.string(),
  kind: z.enum(["google", "impressorx"]),
  /** The Google email, or "pharmacy staff login at <pharmacy>". */
  label: z.string(),
});
export type LinkedLoginView = z.infer<typeof LinkedLoginViewSchema>;

export const LinkedLoginsViewSchema = z.object({ logins: z.array(LinkedLoginViewSchema) });
export type LinkedLoginsView = z.infer<typeof LinkedLoginsViewSchema>;
