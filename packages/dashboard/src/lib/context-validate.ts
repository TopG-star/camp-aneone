import type { ContextChoice } from "./context";

interface ValidateOptions {
  /** The requester's own Cookie header: the agent-server decides from the person's session, as for any browser call. */
  cookie: string;
  /** Tells the agent-server which session cookie name to read (Secure cookies are named differently). */
  forwardedProto?: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

const TIMEOUT_MS = 10_000;

/**
 * Asks the agent-server whether this session may switch to `choice` (POST /api/contexts/validate), replaying the
 * requester's cookie. No service token is sent, so the answer can never be more permissive than the person's own call.
 * True only for a 200; any other answer, or a failure to ask, is false.
 */
export async function validateContextChoice(choice: ContextChoice, options: ValidateOptions): Promise<boolean> {
  if (!options.cookie) return false;
  const baseUrl = (options.baseUrl ?? process.env.AGENT_SERVER_URL ?? "http://localhost:4000").replace(/\/+$/, "");
  try {
    const res = await (options.fetchImpl ?? fetch)(`${baseUrl}/api/contexts/validate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: options.cookie,
        ...(options.forwardedProto ? { "x-forwarded-proto": options.forwardedProto } : {}),
      },
      body: JSON.stringify(choice),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}
