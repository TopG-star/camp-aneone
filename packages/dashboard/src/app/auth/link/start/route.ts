import { NextResponse } from "next/server";
import { linkCookie, serializeLinkIntent } from "../../../../lib/link-cookie";
import { startLinkIntent } from "../../../../lib/link-intent";
import { sessionCookie } from "../../../../lib/session-cookie";

// Starting a link is a POST from the Settings page; every other method is refused.
const notAllowed = () => new NextResponse(null, { status: 405, headers: { Allow: "POST" } });
export const GET = notAllowed;
export const PUT = notAllowed;
export const PATCH = notAllowed;
export const DELETE = notAllowed;

/**
 * Opens a link intent for the person's session and keeps its secret in an HttpOnly cookie (the browser's script never
 * sees it), then says which sign-in comes next. Only the session cookie is replayed to the agent-server, so the intent is
 * bound to the identity that is signed in right now; a request without that session gets nothing.
 */
export async function POST(req: Request) {
  const session = sessionCookie();
  const result = await startLinkIntent({
    cookieHeader: req.headers.get("cookie") ?? "",
    sessionCookieName: session.name,
    secure: session.useSecureCookies,
  });
  if (!result.ok) return NextResponse.json({ error: "link_unavailable" }, { status: result.status });

  const cookie = linkCookie();
  const res = NextResponse.json({ next: result.next }, { headers: { "Cache-Control": "no-store" } });
  res.cookies.set(cookie.name, serializeLinkIntent(result.intent), cookie.options);
  return res;
}
