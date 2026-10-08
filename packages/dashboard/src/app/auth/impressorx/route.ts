import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { signIn } from "../../../lib/auth";
import { isHandoffReason } from "../../../lib/handoff";

// A hand-off arrives as a browser form POST from ImpressoRx; every other method is refused.
const notAllowed = () => new NextResponse(null, { status: 405, headers: { Allow: "POST" } });
export const GET = notAllowed;
export const PUT = notAllowed;
export const PATCH = notAllowed;
export const DELETE = notAllowed;

// A relative Location keeps this independent of the public origin behind any proxy.
const see = (location: string) => new NextResponse(null, { status: 303, headers: { Location: location } });
const failed = (reason: string) => see(`/auth/error?reason=${reason}`);

export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  const handoff = form?.get("handoff");
  if (typeof handoff !== "string" || handoff.length === 0) return failed("generic");

  try {
    // A fresh session id per hand-off. Signing in builds a new session token, so any existing cookie is replaced and
    // nothing of the previous person is linked to this one.
    const url = await signIn("impressorx", { handoff, sessionId: randomUUID(), redirect: false, redirectTo: "/" });
    const target = new URL(String(url), "http://placeholder.invalid");
    if (target.searchParams.get("error")) {
      const code = target.searchParams.get("code");
      return failed(isHandoffReason(code) ? code : "generic");
    }
    return see("/");
  } catch {
    // Never echo the hand-off or the error.
    return failed("generic");
  }
}
