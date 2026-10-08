export type HandoffReason = "expired" | "generic" | "membership_suspended";

/** Spec §6.4: the only things a person who arrives from ImpressoRx is told. */
export const HANDOFF_MESSAGES: Record<HandoffReason, string> = {
  expired: "This link has expired. Go back to ImpressoRx and choose Ask Oneon again.",
  membership_suspended: "This pharmacy has switched Oneon off, or your account is inactive.",
  generic: "Oneon couldn't open this link.",
};

export function isHandoffReason(value: unknown): value is HandoffReason {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(HANDOFF_MESSAGES, value);
}

export type RedeemResult = { ok: true; identityId: string; membershipId: string } | { ok: false; reason: HandoffReason };

interface AgentServerOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /** The agent-server's service API token (API_TOKEN). Server-side only. */
  token?: string | undefined;
}

function resolve(options: AgentServerOptions) {
  return {
    fetchImpl: options.fetchImpl ?? fetch,
    baseUrl: (options.baseUrl ?? process.env.AGENT_SERVER_URL ?? "http://localhost:4000").replace(/\/+$/, ""),
    token: "token" in options ? options.token : process.env.API_TOKEN,
  };
}

const TIMEOUT_MS = 30_000;

/** Asks the agent-server to verify a hand-off and open its session. Never throws; the hand-off is never logged. */
export async function redeemHandoff(handoff: string, sessionId: string, origin: string, options: AgentServerOptions = {}): Promise<RedeemResult> {
  const { fetchImpl, baseUrl, token } = resolve(options);
  if (!token) return { ok: false, reason: "generic" };
  try {
    const res = await fetchImpl(`${baseUrl}/api/auth/handoff/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ handoff, sessionId, origin }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.status === 200 && typeof body?.identityId === "string" && typeof body.membershipId === "string") {
      return { ok: true, identityId: body.identityId, membershipId: body.membershipId };
    }
    return { ok: false, reason: res.status === 401 && body?.error === "handoff_rejected" && isHandoffReason(body.reason) ? body.reason : "generic" };
  } catch {
    return { ok: false, reason: "generic" };
  }
}

/** Revokes the session's attended grant. Best effort: the cookie is cleared by the caller regardless. */
export async function signOutHandoff(sessionId: string, options: AgentServerOptions = {}): Promise<void> {
  const { fetchImpl, baseUrl, token } = resolve(options);
  if (!token) return;
  try {
    await fetchImpl(`${baseUrl}/api/auth/handoff/sign-out`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ sessionId }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // The agent-server revokes locally first; nothing more can be done from here.
  }
}
