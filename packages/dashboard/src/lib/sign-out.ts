import { signOutHandoff } from "./handoff";
import { clearLinkIntentCookie } from "./link-cookie";

interface SignOutDeps {
  signOutHandoff: (sessionId: string) => Promise<void> | void;
  clearLinkCookie: () => Promise<void> | void;
}

const defaults: SignOutDeps = {
  signOutHandoff: (sessionId) => signOutHandoff(sessionId),
  clearLinkCookie: async () => {
    // Only the Auth.js route handler (the sign-out request) has a cookie store to write; anywhere else this throws and is ignored.
    const { cookies } = await import("next/headers");
    clearLinkIntentCookie((await cookies()) as unknown as { set(name: string, value: string, options: object): unknown });
  },
};

/**
 * Auth.js's signOut event. A pending link must not outlive the person who started it: on a shared browser the next person's
 * hand-off would otherwise find it. So whatever signs out, the link intent cookie goes too; a hand-off session also has its
 * attended grant revoked (best effort).
 */
export async function onSignOut(message: object, deps: SignOutDeps = defaults): Promise<void> {
  try {
    await deps.clearLinkCookie();
  } catch {
    // No request to answer: nothing to clear.
  }
  const token = "token" in message ? (message.token as { provider?: unknown; sessionId?: unknown } | null) : null;
  if (token?.provider === "impressorx" && typeof token.sessionId === "string") await deps.signOutHandoff(token.sessionId);
}
