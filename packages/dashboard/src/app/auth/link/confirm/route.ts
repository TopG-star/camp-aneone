import { NextResponse } from "next/server";
import { signOut } from "../../../../lib/auth";
import { clearLinkIntentCookie, linkCookie, readLinkIntent } from "../../../../lib/link-cookie";
import { completeLink, isSameOrigin, linkCsrfMatches, readSealedSession, sessionLogin } from "../../../../lib/link-intent";

// A link is committed by a POST from the confirm page and by nothing else.
const notAllowed = () => new NextResponse(null, { status: 405, headers: { Allow: "POST" } });
export const GET = notAllowed;
export const PUT = notAllowed;
export const PATCH = notAllowed;
export const DELETE = notAllowed;

// A relative Location keeps this independent of the public origin behind any proxy.
const see = (location: string) => new NextResponse(null, { status: 303, headers: { Location: location } });
const forbidden = () => new NextResponse(null, { status: 403 });

/**
 * Commits the link the person just confirmed (spec §4.5). Three things must hold before anything is sent: the request comes
 * from this deployment's own page (Origin), it carries the token only that page, holding the HttpOnly intent cookie, could
 * know, and a session exists to link. The intent cookie is cleared whatever the answer. After a commit the session that
 * signed in second belongs to an identity that was just merged away (or is simply stale), so it is ended and the person is
 * told to sign in again. When the outcome is unknown the session is left alone.
 */
export async function POST(req: Request) {
  if (!isSameOrigin(req)) return forbidden();
  const cookie = linkCookie();
  const intent = readLinkIntent(req.headers.get("cookie") ?? "", cookie.name);
  if (!intent) return see("/");
  const form = await req.formData().catch(() => null);
  const csrf = form?.get("csrf");
  if (typeof csrf !== "string" || !linkCsrfMatches(intent, csrf)) return forbidden();

  const login = sessionLogin(await readSealedSession(req));
  // No session to link yet: the intent stays for the 5 minutes it lives.
  if (!login) return see("/auth/signin");

  const result = await completeLink(intent, login);
  if (result.ok) {
    try {
      await signOut({ redirect: false });
    } catch {
      // The linked page asks for a sign-in either way.
    }
  }
  const res = see(result.ok ? "/auth/linked" : `/auth/error?reason=${result.reason}`);
  clearLinkIntentCookie(res.cookies);
  return res;
}
