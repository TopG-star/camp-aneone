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
 * from this deployment's own page (Origin), a session exists to link, and the token it carries is the one for exactly the
 * login in that session now. The token was issued for the login the page previewed, so if another sign-in has replaced it
 * since (another tab, another person at a shared browser) the person is sent back to the question, which shows the current
 * pairing; nothing is spent and the intent is kept. The intent cookie is cleared whatever the commit's answer. After a
 * commit the session that signed in second belongs to an identity that was just merged away (or is simply stale), so it is
 * ended and the person is told to sign in again. When the outcome is unknown, or there was nothing to link, the session is left alone.
 */
export async function POST(req: Request) {
  if (!isSameOrigin(req)) return forbidden();
  const cookie = linkCookie();
  const intent = readLinkIntent(req.headers.get("cookie") ?? "", cookie.name);
  if (!intent) return see("/");
  const login = sessionLogin(await readSealedSession(req));
  // No session to link yet: the intent stays for the 5 minutes it lives.
  if (!login) return see("/auth/signin");
  const form = await req.formData().catch(() => null);
  const csrf = form?.get("csrf");
  // A missing, forged or stale token (the previewed login is no longer the signed-in one) all come back to the question.
  if (typeof csrf !== "string" || !linkCsrfMatches(intent, login, csrf)) return see("/auth/link/complete");

  const result = await completeLink(intent, login);
  if (result.ok && !result.alreadyLinked) {
    try {
      await signOut({ redirect: false });
    } catch {
      // The linked page asks for a sign-in either way.
    }
  }
  const res = see(result.ok ? (result.alreadyLinked ? "/auth/already-linked" : "/auth/linked") : `/auth/error?reason=${result.reason}`);
  clearLinkIntentCookie(res.cookies);
  return res;
}
