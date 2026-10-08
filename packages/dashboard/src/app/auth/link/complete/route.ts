import { NextResponse } from "next/server";
import { auth } from "../../../../lib/auth";
import { completeLink, linkCookie, readLinkIntent, sessionLogin } from "../../../../lib/link-intent";

// The second sign-in lands here by redirect (a GET); every other method is refused.
const notAllowed = () => new NextResponse(null, { status: 405, headers: { Allow: "GET" } });
export const POST = notAllowed;
export const PUT = notAllowed;
export const PATCH = notAllowed;
export const DELETE = notAllowed;

// A relative Location keeps this independent of the public origin behind any proxy.
const see = (location: string) => new NextResponse(null, { status: 303, headers: { Location: location } });

/**
 * Finishes a link started in Settings (spec §4.5). Both sign-ins end here: Google's callback and the hand-off form POST
 * redirect to this page, which a browser reaches with its Lax cookies even when the hand-off came from another site. The
 * second login is read from the session that sign-in just produced; the first is the intent in the cookie. The cookie is
 * cleared whatever the answer, because the intent is spent (or refused) either way.
 */
export async function GET(req: Request) {
  const cookie = linkCookie();
  const intent = readLinkIntent(req.headers.get("cookie") ?? "", cookie.name);
  if (!intent) return see("/");

  const login = sessionLogin(await auth());
  // No session to link yet: the intent stays for the 5 minutes it lives.
  if (!login) return see("/auth/signin");

  const result = await completeLink(intent, login);
  const res = see(result.ok ? "/" : `/auth/error?reason=${result.reason}`);
  res.cookies.set(cookie.name, "", { ...cookie.options, maxAge: 0 });
  return res;
}
