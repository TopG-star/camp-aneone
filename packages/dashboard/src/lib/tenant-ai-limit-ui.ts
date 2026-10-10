import type { TenantAiLimitView } from "@oneon/contracts";
import { formatDate } from "./connections-ui";

// Settings → AI data in a pharmacy: the pharmacy's own limit on what Oneon may send to AI providers (spec 9.4). Every sentence says
// only what happened: a change that was refused changed nothing.

export type TenantLimitClass = TenantAiLimitView["current"];
/** The levels a pharmacy may choose. D3 and D4 are never on offer. */
export const TENANT_LIMIT_CLASSES: TenantLimitClass[] = ["D0", "D1", "D2"];

const CLASS_LABELS: Record<string, string> = {
  D0: "Public only (nothing about your pharmacy's business; chat replies in this pharmacy are refused at this level)",
  D1: "Internal (stock and aggregate sales; no customer or supplier names)",
  D2: "Confidential (names, prices and other identifying detail)",
};

export const tenantClassLabel = (cls: string): string => CLASS_LABELS[cls] ?? cls;

export const TENANT_LIMIT_LOAD_FAILED = "Couldn't load the pharmacy's AI data limit.";

export function historyEntryText(entry: Pick<TenantAiLimitView["history"][number], "maxClass" | "at" | "byYou">): string {
  return `${tenantClassLabel(entry.maxClass)} · ${formatDate(entry.at)} · by ${entry.byYou ? "you" : "a colleague"}`;
}

/** Why a change was not made (the route's answers, spec 9.3 and 9.4). A 403 from a pharmacy that cannot open carries its own message. */
export function changeFailureText(status: number, message: string): string {
  if (status === 409 && message === "limit_changed") {
    return "Someone else changed the limit after this page loaded, so nothing was changed. The page now shows the current limit; choose again if you still want to change it.";
  }
  if (status === 409) {
    return "The limit can't be raised to this level. A raise has to stay within what a configured AI provider may receive for a pharmacy, and a raise to the Confidential level also needs a provider that Oneon has fully reviewed and that holds a signed data processing agreement.";
  }
  if (status === 403 && message === "permission_required") {
    return "Only a pharmacy administrator can change this. Your access in ImpressoRx doesn't include managing Oneon. Nothing was changed.";
  }
  if (status === 403 && message === "context_unavailable") {
    return "This pharmacy isn't available right now. Open Oneon from ImpressoRx again, or ask a pharmacy administrator. Nothing was changed.";
  }
  // A pharmacy that cannot open explains itself in words; a bare code is never shown.
  if (status === 403 && /\s/.test(message.trim())) return message;
  if (status === 403) return "You can't change this right now. Nothing was changed.";
  if (status === 503) return "Oneon can't reach ImpressoRx right now, so it can't check your access. Nothing was changed. Try again in a moment.";
  return "Couldn't change the limit. Nothing was changed. Try again.";
}
