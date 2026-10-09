import { linkCookie, readLinkIntent } from "./link-cookie";
import { linkCsrfToken, previewLink, readSealedSession, sessionLogin } from "./link-intent";
import type { LinkReason } from "./link-messages";

export type Confirmation =
  /** No link in progress. */
  | { state: "none" }
  /** A link is in progress but there is no session to link yet. */
  | { state: "signin" }
  | { state: "refused"; reason: LinkReason }
  /** The question to put to the person, and the token the Confirm button must carry. */
  | { state: "ready"; question: string; csrf: string };

/** "Link <role> at <pharmacy> to <Google email>?" — naming each pharmacy sign-in that would be merged. */
export function confirmationQuestion(memberships: Array<{ role: string; pharmacyName: string }>, googleEmail: string): string {
  if (memberships.length === 0) return `Link your pharmacy account to ${googleEmail}?`;
  return `Link ${memberships.map((m) => `${m.role} at ${m.pharmacyName}`).join(" and ")} to ${googleEmail}?`;
}

/**
 * What GET /auth/link/complete shows. It only ever asks the agent-server for the read-only preview: opening the page links
 * nothing and spends nothing. The link is made by a same-origin POST to /auth/link/confirm with the token returned here.
 */
export async function loadLinkConfirmation(
  cookieHeader: string,
  options: { env?: Record<string, string | undefined>; fetchImpl?: typeof fetch; baseUrl?: string; token?: string | undefined } = {},
): Promise<Confirmation> {
  const env = options.env ?? process.env;
  const intent = readLinkIntent(cookieHeader, linkCookie(env).name);
  if (!intent) return { state: "none" };
  const login = sessionLogin(await readSealedSession({ headers: new Headers({ cookie: cookieHeader }) }, env));
  if (!login) return { state: "signin" };

  const { env: _env, ...service } = options;
  const preview = await previewLink(intent, login, service);
  if (!preview.ok) return { state: "refused", reason: preview.reason };
  return { state: "ready", question: confirmationQuestion(preview.memberships, preview.googleEmail), csrf: linkCsrfToken(intent) };
}
