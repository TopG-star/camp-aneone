import type { ConnectionGrantView, LinkedLoginView, ReconnectActionView, RevokeConnectionResult } from "@oneon/contracts";
import type { ContextChoice, ContextsResponse } from "./context";

// Settings → Connections wording. Every sentence says only what happened: Oneon's own revoke always did; ImpressoRx's did not
// unless it answered.

export const CONNECTIONS_LOAD_FAILED = "Couldn't load your connections.";
export const RECONNECT_HELP = "Open Oneon from ImpressoRx to reconnect, then retry the action.";
export const UNLINK_WARNING = "Unlinking separates this pharmacy sign-in from your account and revokes its connections. Continue?";
const UNLINK_WARNING_CURRENT =
  "This is the sign-in you're using now. Unlinking separates it from your account, revokes its connections and signs you out. Continue?";

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

const DAY_MS = 24 * 60 * 60 * 1000;

/** The date, and the time too when it is less than a day away, where the hour matters. */
export function formatWhen(iso: string, now: Date = new Date()): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return formatDate(iso);
  const ahead = time - now.getTime();
  if (ahead < 0 || ahead >= DAY_MS) return formatDate(iso);
  return `${formatDate(iso)}, ${new Date(time).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
}

/** last_used_at only moves when the grant is exchanged for a token, so a grant in active use can still have none. */
export function lastUsedText(lastUsedAt: string | null): string {
  return lastUsedAt ? `Last used ${formatDate(lastUsedAt)}` : "No exchange yet";
}

export function endsText(expiresAt: string, now: Date = new Date()): string {
  return `Ends ${formatWhen(expiresAt, now)} if unused`;
}

/**
 * `unreachable` is "ImpressoRx did not confirm": it may not have been asked, may not have answered, or may have refused. So the notice does
 * not say it could not be reached; it says the grant may stay open there until `expiresAt`, when it ends on its own.
 */
export function revokeNotice(remote: RevokeConnectionResult["remote"], expiresAt: string, now: Date = new Date()): string {
  return remote === "revoked"
    ? "Revoked in Oneon and at ImpressoRx."
    : `Revoked in Oneon. ImpressoRx didn't confirm it, so it may stay open there until ${formatWhen(expiresAt, now)}.`;
}

/** Revoking the connection this session is signed in with ends the session, so that one asks first. */
export function revokeWarning(grant: Pick<ConnectionGrantView, "current" | "tenantName">): string | null {
  return grant.current ? `This is the connection you're signed in with. Revoking it signs you out of ${grant.tenantName}. Continue?` : null;
}

/** Unlinking the sign-in this session is in signs the person out, so that one says so. */
export function unlinkWarning(login: Pick<LinkedLoginView, "current">): string {
  return login.current ? UNLINK_WARNING_CURRENT : UNLINK_WARNING;
}

export type ReconnectLink =
  | { kind: "open"; href: string }
  | { kind: "switch"; choice: Extract<ContextChoice, { kind: "tenant" }>; href: string }
  | { kind: "reconnect" };

/**
 * Where an action that needs a reconnect leads. The Actions page only shows an action while the session is in its pharmacy, so: link to it
 * when the session is in that very membership; offer a switch when the context picker offers that membership (then go to the action);
 * otherwise only the reconnect text. A hand-off session is offered only its own membership, so it never gets a switch to another one.
 */
export function reconnectLink(item: Pick<ReconnectActionView, "actionId" | "membershipId">, contexts: ContextsResponse | undefined): ReconnectLink {
  const href = `/actions#action-${item.actionId}`;
  if (!contexts) return { kind: "reconnect" };
  if (contexts.active.kind === "tenant" && contexts.active.membershipId === item.membershipId) return { kind: "open", href };
  const offered = contexts.available.some((option) => option.kind === "tenant" && option.membershipId === item.membershipId);
  return offered ? { kind: "switch", choice: { kind: "tenant", membershipId: item.membershipId }, href } : { kind: "reconnect" };
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
