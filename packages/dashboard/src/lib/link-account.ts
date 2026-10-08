/** What the Settings button tells a Google session to do: the hand-off is the other sign-in, and it must arrive while the intent lives. */
export const HANDOFF_NOTICE = "Open Oneon from ImpressoRx within 5 minutes to finish linking your account.";
export const LINK_START_FAILED = "Couldn't start linking. Try again.";

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
