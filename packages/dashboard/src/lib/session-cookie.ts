interface CookieEnv {
  NODE_ENV?: string;
  AUTH_URL?: string;
  NEXTAUTH_URL?: string;
}

/**
 * The session cookie (spec §6.5): HttpOnly, SameSite=Lax, and Secure everywhere except plain-http development. The
 * name is Auth.js's own, so the agent-server finds it, and doubles as the encryption salt.
 */
export function sessionCookie(env: CookieEnv = process.env) {
  const url = env.AUTH_URL ?? env.NEXTAUTH_URL ?? "";
  const secure = env.NODE_ENV === "production" || url.startsWith("https://");
  return {
    useSecureCookies: secure,
    name: secure ? "__Secure-authjs.session-token" : "authjs.session-token",
    options: { httpOnly: true, sameSite: "lax" as const, path: "/", secure },
  };
}
