import { CredentialsSignin } from "next-auth";
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
    // Signing in builds a new session token, so any existing cookie is replaced and nothing of the previous person is
    // linked to this one. The session id is generated in authorize. The Origin header is checked against the deployment.
    await signIn("impressorx", { handoff, origin: req.headers.get("origin") ?? "", redirect: false, redirectTo: "/" });
    return see("/");
  } catch (error) {
    // A rejected hand-off makes signIn throw the CredentialsSignin from authorize; its code is the reason.
    // Never echo the hand-off or anything else.
    return failed(error instanceof CredentialsSignin && isHandoffReason(error.code) ? error.code : "generic");
  }
}
