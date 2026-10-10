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
  /** The caller's own active membership at that pharmacy (the context picker offers the same id), so the page can tell whether the session is in it. */
  membershipId: z.string(),
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

/**
 * `unreachable`: revoked in Oneon, but ImpressoRx did not confirm. It may not have been asked (its registration is not active), may not have
 * answered, or may have refused (a 401), so the connection may stay open there until it expires. It does not mean the network was down.
 */
export const RevokeConnectionResultSchema = z.object({ remote: z.enum(["revoked", "unreachable"]) });
export type RevokeConnectionResult = z.infer<typeof RevokeConnectionResultSchema>;

export const LinkedLoginViewSchema = z.object({
  id: z.string(),
  kind: z.enum(["google", "impressorx"]),
  /** The Google email, or "pharmacy staff login at <pharmacy>". */
  label: z.string(),
  /** The login this hand-off session came in through: unlinking it signs the person out. Always false for any other session. */
  current: z.boolean(),
});
export type LinkedLoginView = z.infer<typeof LinkedLoginViewSchema>;

export const LinkedLoginsViewSchema = z.object({ logins: z.array(LinkedLoginViewSchema) });
export type LinkedLoginsView = z.infer<typeof LinkedLoginsViewSchema>;
