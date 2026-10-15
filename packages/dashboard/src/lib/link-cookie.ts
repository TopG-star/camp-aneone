/**
 * The link intent's cookie (spec §4.5). No Node-only imports: Auth.js's sign-out event clears it, and that module also loads
 * in the edge middleware.
 */

/** What links a hand-off session and a Google session into one identity. Server-side only. */
export interface LinkIntent {
  linkIntentId: string;
  secret: string;
}

interface CookieEnv {
  NODE_ENV?: string | undefined;
  AUTH_URL?: string | undefined;
  NEXTAUTH_URL?: string | undefined;
}

/**
 * Where the intent's secret waits between the two sign-ins: a cookie the page's scripts cannot read, for the 5 minutes an
 * intent lives. Over https it is a __Host- cookie (Secure, Path=/, no Domain), which a browser only accepts from this exact
 * host, so a sibling subdomain cannot plant one; plain-http development cannot use the prefix and keeps a plain name,
 * limited to the link pages, as the session cookie's name is chosen. It is SameSite=Lax like the session cookie, so a
 * hand-off arriving as a form POST from ImpressoRx does not carry it; /auth/link/complete, reached by a redirect (a GET), does.
 */
export function linkCookie(env: CookieEnv = process.env) {
  const url = env.AUTH_URL ?? env.NEXTAUTH_URL ?? "";
  const secure = env.NODE_ENV === "production" || url.startsWith("https://");
  return {
    name: secure ? "__Host-oneon-link-intent" : "oneon-link-intent",
    options: { httpOnly: true, sameSite: "lax" as const, secure, path: secure ? "/" : "/auth/link", maxAge: 300 },
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

/** Expires the cookie on the path it was set on (any cookie store with `set`: a response's, or the request's mutable one). */
export function clearLinkIntentCookie(store: { set(name: string, value: string, options: object): unknown }, env: CookieEnv = process.env): void {
  const cookie = linkCookie(env);
  store.set(cookie.name, "", { ...cookie.options, maxAge: 0 });
}
