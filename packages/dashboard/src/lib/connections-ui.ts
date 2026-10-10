import type { ConnectionGrantView, RevokeConnectionResult } from "@oneon/contracts";

// Settings → Connections wording. Every sentence says only what happened: Oneon's own revoke always did; ImpressoRx's did not
// unless it answered.

export const CONNECTIONS_LOAD_FAILED = "Couldn't load your connections.";
export const RECONNECT_HELP = "Open Oneon from ImpressoRx to reconnect, then retry the action.";
export const UNLINK_WARNING = "Unlinking separates this pharmacy sign-in from your account and revokes its connections. Continue?";

const KIND_LABEL: Record<ConnectionGrantView["kind"], string> = {
  attended: "Your sign-in",
  action: "Approved action",
  schedule: "Scheduled work",
};

export function kindLabel(kind: ConnectionGrantView["kind"]): string {
  return KIND_LABEL[kind];
}

export function connectionTitle(grant: Pick<ConnectionGrantView, "kind" | "tenantName">): string {
  return `${kindLabel(grant.kind)} · ${grant.tenantName}`;
}

/** What a connection may do: the permissions it was limited to, or for a sign-in, the person's own access. */
export function scopeText(kind: ConnectionGrantView["kind"], scope: string[]): string {
  if (scope.length > 0) return scope.join(", ");
  return kind === "attended" ? "Your own access while you're signed in" : "No specific permissions listed";
}

export function formatDate(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? "an unknown date" : new Date(time).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** `expiresAt` is when the grant ends at ImpressoRx on its own, which is all that is left of it if ImpressoRx was not told. */
export function revokeNotice(remote: RevokeConnectionResult["remote"], expiresAt: string): string {
  return remote === "revoked"
    ? "Revoked in Oneon and at ImpressoRx."
    : `Revoked in Oneon. ImpressoRx couldn't be reached; this connection expires on ${formatDate(expiresAt)}.`;
}

/** Revoking the connection this session is signed in with ends the session, so that one asks first. */
export function revokeWarning(grant: Pick<ConnectionGrantView, "current" | "tenantName">): string | null {
  return grant.current ? `This is the connection you're signed in with. Revoking it signs you out of ${grant.tenantName}. Continue?` : null;
}

export function revokeFailureText(status: number): string {
  return status === 404 ? "That connection is no longer there." : "Couldn't revoke this connection. Try again.";
}

export function unlinkFailureText(status: number): string {
  if (status === 404) return "That sign-in is no longer linked.";
  if (status === 409) return "That sign-in can't be unlinked. It may be the only one on your account.";
  return "Couldn't unlink that sign-in. Try again.";
}

/** Pharmacies whose actions could not be checked: said, so "nothing needs you" is not claimed about them. */
export function unavailableNote(names: string[]): string | null {
  if (names.length === 0) return null;
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Couldn't check ${list} right now.`;
}
