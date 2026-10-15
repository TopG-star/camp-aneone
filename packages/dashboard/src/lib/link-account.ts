/** What the Settings button tells a Google session to do: the hand-off is the other sign-in, and it must arrive while the intent lives. */
export const HANDOFF_NOTICE = "Open Oneon from ImpressoRx within 5 minutes to finish linking your account.";
export const LINK_START_FAILED = "Couldn't start linking. Try again.";
/**
 * What linking does not do, so it does not overclaim: a Google session has no session-bound pharmacy grant (its pharmacy
 * snapshot goes stale after 5 minutes, then it must relaunch from ImpressoRx), and a hand-off session is never given Personal.
 */
export const LINK_SCOPE_NOTE =
  "Linking doesn't let one session switch freely between Personal and a pharmacy. Signed in with Google, you can use a pharmacy only for a few minutes after you last used it from ImpressoRx. Opened from ImpressoRx, you can't open Personal: sign in with Google for that.";

/**
 * Starts a link on the dashboard's server (/auth/link/start), which keeps the intent's secret in an HttpOnly cookie. `next`
 * says which sign-in completes it: "google" for a hand-off session, "handoff" for a Google session.
 */
export async function requestLink(fetchImpl: typeof fetch = fetch): Promise<{ next: "google" | "handoff" } | { error: string }> {
  try {
    const res = await fetchImpl("/auth/link/start", { method: "POST", credentials: "include" });
    const body = (await res.json().catch(() => null)) as { next?: unknown } | null;
    if (res.ok && (body?.next === "google" || body?.next === "handoff")) return { next: body.next };
  } catch {
    // Reported below like any other failure.
  }
  return { error: LINK_START_FAILED };
}
