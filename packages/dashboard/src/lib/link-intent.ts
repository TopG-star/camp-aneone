import { createHmac, timingSafeEqual } from "node:crypto";
import { getToken } from "next-auth/jwt";
import { sessionCookieOnly } from "./context-validate";
import type { LinkIntent } from "./link-cookie";
import { isLinkReason, type LinkReason } from "./link-messages";
import { sessionCookie } from "./session-cookie";

/**
 * The second sign-in, as the agent-server wants it. A hand-off has no subject the dashboard knows: it names the identity the
 * agent-server created for it, with the session id and membership of its sealed session, so the server can check them itself.
 */
export type LinkLogin =
  | { kind: "google"; subject: string; email: string }
  | { kind: "impressorx"; identityId: string; sessionId: string; membershipId: string };

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

/** What the sealed session cookie says about the sign-in that produced it. Read on the server; never sent to the browser. */
export interface SealedSession {
  provider: "google" | "impressorx";
  sub: string;
  email?: string | undefined;
  /** Hand-off sessions only. */
  identityId?: string | undefined;
  sessionId?: string | undefined;
  membershipId?: string | undefined;
}

type Env = Record<string, string | undefined>;

/**
 * Decrypts the request's own session cookie (the same cookie, name and secret Auth.js uses) and reads the sign-in out of it.
 * Nothing about the session id or membership is exposed through the session object the browser can read.
 */
export async function readSealedSession(req: { headers: Headers }, env: Env = process.env): Promise<SealedSession | null> {
  const secret = env.AUTH_SECRET ?? env.NEXTAUTH_SECRET;
  if (!secret) return null;
  const cookie = sessionCookie(env);
  const token = await getToken({ req, secret, cookieName: cookie.name, salt: cookie.name, secureCookie: cookie.useSecureCookies });
  if (!token || typeof token.sub !== "string" || !token.sub) return null;
  const str = (value: unknown) => (typeof value === "string" && value ? value : undefined);
  const context = token.activeContext as { membershipId?: unknown } | undefined;
  return {
    // A token from before `provider` existed is a Google one.
    provider: token.provider === "impressorx" ? "impressorx" : "google",
    sub: token.sub,
    email: str(token.email),
    identityId: str(token.identityId),
    sessionId: str(token.sessionId),
    membershipId: str(context?.membershipId),
  };
}

/** Who just signed in for the second time, as the agent-server wants to hear it; null when the session lacks what it needs. */
export function sessionLogin(sealed: SealedSession | null | undefined): LinkLogin | null {
  if (!sealed?.sub) return null;
  if (sealed.provider === "impressorx") {
    return sealed.identityId && sealed.sessionId && sealed.membershipId
      ? { kind: "impressorx", identityId: sealed.identityId, sessionId: sealed.sessionId, membershipId: sealed.membershipId }
      : null;
  }
  return sealed.email ? { kind: "google", subject: sealed.sub, email: sealed.email } : null;
}

const CSRF_PREFIX = "oneon-link-confirm:";

/**
 * The token the confirm form carries. It is derived from the intent's secret, which only this browser's HttpOnly cookie
 * holds, so a page on another site can neither read nor compute it; each intent has its own and it dies with the intent.
 */
export function linkCsrfToken(intent: LinkIntent): string {
  return createHmac("sha256", intent.secret).update(`${CSRF_PREFIX}${intent.linkIntentId}`).digest("base64url");
}

export function linkCsrfMatches(intent: LinkIntent, presented: string): boolean {
  const expected = Buffer.from(linkCsrfToken(intent));
  const given = Buffer.from(presented);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * True only for a request the dashboard's own page made: its Origin is this deployment's. The public URL (AUTH_URL) is
 * trusted when configured; behind a proxy the forwarded host and protocol stand in for the internal URL.
 */
export function isSameOrigin(req: Request, env: Env = process.env): boolean {
  const origin = req.headers.get("origin");
  if (!origin || origin === "null") return false;
  const allowed = new Set<string>();
  const url = new URL(req.url);
  allowed.add(url.origin);
  const publicUrl = env.AUTH_URL ?? env.NEXTAUTH_URL;
  if (publicUrl) {
    try {
      allowed.add(new URL(publicUrl).origin);
    } catch {
      // A malformed setting trusts nothing extra.
    }
  }
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = (req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "")).split(",")[0]!.trim();
  if (host) allowed.add(`${proto}://${host.split(",")[0]!.trim()}`);
  return allowed.has(origin);
}

type ServiceOptions = AgentServerOptions & { token?: string | undefined };
const tokenOf = (options: ServiceOptions) => ("token" in options ? options.token : process.env.API_TOKEN);

export type PreviewResult =
  | { ok: true; googleEmail: string; memberships: Array<{ role: string; pharmacyName: string }> }
  | { ok: false; reason: LinkReason };

const unexpected = { ok: false, reason: "link_incomplete" } as const;

/** What the link would do, asked read-only (POST /api/identity/link/preview, service token): nothing is spent or changed. */
export async function previewLink(intent: LinkIntent, login: LinkLogin, options: ServiceOptions = {}): Promise<PreviewResult> {
  const token = tokenOf(options);
  if (!token) return unexpected;
  try {
    const res = await (options.fetchImpl ?? fetch)(`${baseUrlOf(options)}/api/identity/link/preview`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ linkIntentId: intent.linkIntentId, secret: intent.secret, login }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => null)) as { error?: unknown; googleEmail?: unknown; memberships?: unknown } | null;
    if (res.status === 200 && typeof body?.googleEmail === "string" && Array.isArray(body.memberships)) {
      const memberships = body.memberships.filter(
        (m): m is { role: string; pharmacyName: string } => typeof m?.role === "string" && typeof m?.pharmacyName === "string",
      );
      return { ok: true, googleEmail: body.googleEmail, memberships };
    }
    return res.status === 409 && isLinkReason(body?.error) ? { ok: false, reason: body.error } : unexpected;
  } catch {
    return unexpected;
  }
}

export type CompleteResult = { ok: true } | { ok: false; reason: LinkReason };

/**
 * Commits the link (POST /api/identity/link, service token). The secret is only ever sent here and to the preview, and never logged.
 * A reply that never arrived (timeout, network error, a proxy's 502/504) is link_outcome_unknown, not a failure: the merge may
 * have committed. Only an answer from the agent-server itself says it did not.
 */
export async function completeLink(intent: LinkIntent, login: LinkLogin, options: ServiceOptions = {}): Promise<CompleteResult> {
  const token = tokenOf(options);
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
    return { ok: false, reason: isLinkReason(body?.error) ? body.error : "link_outcome_unknown" };
  } catch {
    return { ok: false, reason: "link_outcome_unknown" };
  }
}
