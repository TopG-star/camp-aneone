import { parseContextChoice, type ContextChoice } from "./context";

type Token = Record<string, unknown>;

interface SignIn {
  account?: { provider?: string } | null;
  user?: { id?: string; identityId?: string; membershipId?: string; sessionId?: string } | null;
  profile?: { email?: string | null; sub?: string | null } | null;
}

/**
 * The Auth.js `jwt` callback. Auth.js passes `account` only on the request that signs someone in.
 * - A hand-off session is built from scratch: identity, session id and active context, no email and no Google sub, so
 *   nothing of an earlier session (another person's Google sign-in, say) carries over and nothing is linked.
 * - A Google session records its provider and Google's stable subject.
 */
export function applySignIn<T extends Token>(token: T, { account, user, profile }: SignIn): T | Token {
  if (account?.provider === "impressorx") {
    if (!user?.identityId || !user.membershipId || !user.sessionId) throw new Error("Incomplete hand-off sign-in");
    return {
      sub: user.identityId,
      provider: "impressorx",
      identityId: user.identityId,
      sessionId: user.sessionId,
      activeContext: { kind: "tenant", membershipId: user.membershipId },
    };
  }
  if (account) {
    (token as Token).provider = "google";
  }
  if (profile?.email) {
    (token as Token).email = profile.email.toLowerCase();
  }
  // Google's stable subject; Auth.js already defaults token.sub to it, set explicitly so it cannot drift.
  if (profile?.sub) {
    (token as Token).sub = profile.sub;
  }
  return token;
}

/**
 * The Auth.js `jwt` callback on `update({ activeContext })`. The requested context comes from the browser, so it is
 * stored only after `validate` (the agent-server's check for this session) says yes; a malformed request, a refusal
 * or a failed check leaves the token as it was. The agent-server checks the stored context again on every request.
 */
export async function applyContextUpdate<T extends Token>(
  token: T,
  requested: unknown,
  validate: (choice: ContextChoice) => Promise<boolean>,
): Promise<T> {
  const choice = parseContextChoice(requested);
  if (!choice) return token;
  let allowed = false;
  try {
    allowed = await validate(choice);
  } catch {
    allowed = false;
  }
  if (allowed) (token as Token).activeContext = choice;
  return token;
}
