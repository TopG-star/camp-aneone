/**
 * Why a link did not go through (spec §4.5), and what the person is told. The agent-server answers the first five or
 * link_incomplete; link_outcome_unknown is the dashboard's own, for a commit whose answer never arrived and so may have happened.
 * Client-safe: the error page imports it.
 */
export type LinkReason =
  | "link_expired"
  | "link_conflict"
  | "link_needs_google"
  | "link_account_disabled"
  | "link_unavailable"
  | "link_incomplete"
  | "link_outcome_unknown";

export const LINK_MESSAGES: Record<LinkReason, string> = {
  link_expired: "That link request has expired, was already used, or couldn't be confirmed. Start again from Settings.",
  link_conflict: "These accounts can't be linked: that would put two Google accounts on one Oneon account, which isn't supported.",
  link_needs_google: "Neither of these accounts has a Google sign-in, so there is nothing to link them to. Sign in with Google first, then link.",
  link_account_disabled: "One of these accounts has been switched off or already merged into another, so it can't be linked.",
  link_unavailable: "A pharmacy on this account is switched off for now, so linking has to wait. Try again when the pharmacy is back.",
  link_incomplete: "Linking didn't finish. Try again from Settings; a fresh attempt completes the link.",
  link_outcome_unknown: "We couldn't tell whether linking finished. Check Settings to see whether your accounts are linked, or try again.",
};

export function isLinkReason(value: unknown): value is LinkReason {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(LINK_MESSAGES, value);
}
