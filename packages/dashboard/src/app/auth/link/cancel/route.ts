import { NextResponse } from "next/server";
import { clearLinkIntentCookie } from "../../../../lib/link-cookie";
import { isSameOrigin } from "../../../../lib/link-intent";

const notAllowed = () => new NextResponse(null, { status: 405, headers: { Allow: "POST" } });
export const GET = notAllowed;
export const PUT = notAllowed;
export const PATCH = notAllowed;
export const DELETE = notAllowed;

/** Cancel on the confirm page: forgets the intent in this browser and tells the agent-server nothing, so nothing is spent. */
export async function POST(req: Request) {
  if (!isSameOrigin(req)) return new NextResponse(null, { status: 403 });
  const res = new NextResponse(null, { status: 303, headers: { Location: "/" } });
  clearLinkIntentCookie(res.cookies);
  return res;
}
