import type { ContextChoice } from "./context";

interface ValidateOptions {
  /** The requester's Cookie header. Only the session cookie in use is replayed (see sessionCookieOnly). */
  cookieHeader: string;
  /** The name of the session cookie this deployment uses (the Auth.js cookie configuration). */
  sessionCookieName: string;
  /** Whether that cookie is a Secure one; decides the protocol the agent-server is told, so it reads the same cookie name. */
  secure: boolean;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

const TIMEOUT_MS = 10_000;

/**
 * The session cookie named `name`, with its chunks (`name.0`, `name.1`, ...), out of a Cookie header, and nothing else.
 * A request can carry both cookie names (the Secure one and the plain one); only the one this deployment uses is the
 * person's session, so only that one is ever replayed.
 */
export function sessionCookieOnly(cookieHeader: string, name: string): string {
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => {
      const cookieName = part.slice(0, Math.max(part.indexOf("="), 0));
      return cookieName === name || (cookieName.startsWith(`${name}.`) && /^\d+$/.test(cookieName.slice(name.length + 1)));
    })
    .join("; ");
}

/**
 * Asks the agent-server whether this session may switch to `choice` (POST /api/contexts/validate), replaying the
 * requester's session cookie. No service token is sent, so the answer can never be more permissive than the person's own
 * call. The protocol comes from the cookie configuration, never from the request, so a forged header cannot make the
 * agent-server read the other cookie name. True only for a 200; any other answer, or a failure to ask, is false.
 */
export async function validateContextChoice(choice: ContextChoice, options: ValidateOptions): Promise<boolean> {
  const cookie = sessionCookieOnly(options.cookieHeader, options.sessionCookieName);
  if (!cookie) return false;
  const baseUrl = (options.baseUrl ?? process.env.AGENT_SERVER_URL ?? "http://localhost:4000").replace(/\/+$/, "");
  try {
    const res = await (options.fetchImpl ?? fetch)(`${baseUrl}/api/contexts/validate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        ...(options.secure ? { "x-forwarded-proto": "https" } : {}),
      },
      body: JSON.stringify(choice),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}
