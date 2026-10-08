import { sessionCookieOnly } from "./context-validate";

/** What links a hand-off session and a Google session into one identity (spec §4.5). Server-side only. */
export interface LinkIntent {
  linkIntentId: string;
  secret: string;
}

/** The second sign-in, as the agent-server wants it (a hand-off has no subject the dashboard knows: it names its identity). */
export type LinkLogin = { kind: "google"; subject: string; email: string } | { kind: "impressorx"; identityId: string };

export type LinkReason = "link_expired" | "link_conflict" | "link_incomplete";

export const LINK_MESSAGES: Record<LinkReason, string> = {
  link_expired: "That link request has expired or was already used. Start again from Settings.",
  link_conflict: "These two accounts can't be linked: both already have a Google account, or one is switched off.",
  link_incomplete: "Linking didn't finish and nothing was changed. Start again from Settings.",
};

export function isLinkReason(value: unknown): value is LinkReason {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(LINK_MESSAGES, value);
}

interface CookieEnv {
  NODE_ENV?: string;
  AUTH_URL?: string;
  NEXTAUTH_URL?: string;
}

/**
 * Where the intent's secret waits between the two sign-ins: a cookie the page's scripts cannot read, sent to the link
 * pages only, for the 5 minutes an intent lives. It is SameSite=Lax like the session cookie, so a hand-off arriving as a
 * form POST from ImpressoRx does not carry it; /auth/link/complete, reached by a redirect (a GET), does.
 */
export function linkCookie(env: CookieEnv = process.env) {
  const url = env.AUTH_URL ?? env.NEXTAUTH_URL ?? "";
  const secure = env.NODE_ENV === "production" || url.startsWith("https://");
  return {
    name: secure ? "__Secure-oneon-link-intent" : "oneon-link-intent",
    options: { httpOnly: true, sameSite: "lax" as const, secure, path: "/auth/link", maxAge: 300 },
  };
}

const ID = /^[0-9a-f-]{36}$/i;
const SECRET = /^[A-Za-z0-9_-]{32,128}$/;

export function serializeLinkIntent(intent: LinkIntent): string {
  return `${intent.linkIntentId}.${intent.secret}`;
}

/** The intent in a Cookie header, or null when it is absent or malformed. */
export function readLinkIntent(cookieHeader: string, name: string): LinkIntent | null {
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${name}=`)) continue;
    const [linkIntentId, secret, ...rest] = trimmed.slice(name.length + 1).split(".");
    return rest.length === 0 && linkIntentId && secret && ID.test(linkIntentId) && SECRET.test(secret) ? { linkIntentId, secret } : null;
  }
  return null;
}

interface AgentServerOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

const baseUrlOf = (options: AgentServerOptions) => (options.baseUrl ?? process.env.AGENT_SERVER_URL ?? "http://localhost:4000").replace(/\/+$/, "");
const TIMEOUT_MS = 10_000;

export type StartResult = { ok: true; intent: LinkIntent; next: "google" | "handoff" } | { ok: false; status: number };

/**
 * Opens an intent for the person's current session (POST /api/identity/link-intent), replaying only their session cookie and
 * no service token, so the agent-server acts for exactly this session. `next` says which sign-in completes the link.
 */
export async function startLinkIntent(
  options: AgentServerOptions & { cookieHeader: string; sessionCookieName: string; secure: boolean },
): Promise<StartResult> {
  const cookie = sessionCookieOnly(options.cookieHeader, options.sessionCookieName);
  if (!cookie) return { ok: false, status: 401 };
  try {
    const res = await (options.fetchImpl ?? fetch)(`${baseUrlOf(options)}/api/identity/link-intent`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, ...(options.secure ? { "x-forwarded-proto": "https" } : {}) },
      body: "{}",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status !== 200) return { ok: false, status: res.status };
    const body = (await res.json()) as { linkIntentId?: unknown; secret?: unknown; next?: unknown };
    if (typeof body.linkIntentId !== "string" || typeof body.secret !== "string" || (body.next !== "google" && body.next !== "handoff")) {
      return { ok: false, status: 502 };
    }
    return { ok: true, intent: { linkIntentId: body.linkIntentId, secret: body.secret }, next: body.next };
  } catch {
    return { ok: false, status: 502 };
  }
}

interface SessionLike {
  provider?: string;
  user?: { sub?: string; email?: string | null } | null;
}

/**
 * Who just signed in, from the session the second sign-in produced. A token from before `provider` existed is a Google one;
 * a hand-off token's subject is its identity id (see applySignIn).
 */
export function sessionLogin(session: SessionLike | null | undefined): LinkLogin | null {
  const sub = session?.user?.sub;
  if (!sub) return null;
  if (session.provider === "impressorx") return { kind: "impressorx", identityId: sub };
  const email = session.user?.email;
  return email ? { kind: "google", subject: sub, email } : null;
}

export type CompleteResult = { ok: true } | { ok: false; reason: LinkReason };

/** Finishes the link (POST /api/identity/link, service token). The secret is only ever sent here and never logged. */
export async function completeLink(
  intent: LinkIntent,
  login: LinkLogin,
  options: AgentServerOptions & { token?: string | undefined } = {},
): Promise<CompleteResult> {
  const token = "token" in options ? options.token : process.env.API_TOKEN;
  if (!token) return { ok: false, reason: "link_incomplete" };
  try {
    const res = await (options.fetchImpl ?? fetch)(`${baseUrlOf(options)}/api/identity/link`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ linkIntentId: intent.linkIntentId, secret: intent.secret, login }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 200) return { ok: true };
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    return { ok: false, reason: isLinkReason(body?.error) ? body.error : "link_incomplete" };
  } catch {
    return { ok: false, reason: "link_incomplete" };
  }
}
