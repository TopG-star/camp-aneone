import type { TenantAiLimitView } from "@oneon/contracts";
import { formatDate } from "./connections-ui";

// Settings → AI data in a pharmacy: the pharmacy's own limit on what Oneon may send to AI providers (spec 9.4). Every sentence says
// only what happened: a change that was refused changed nothing.

export type TenantLimitClass = TenantAiLimitView["current"];
/** The levels a pharmacy may choose. D3 and D4 are never on offer. */
export const TENANT_LIMIT_CLASSES: TenantLimitClass[] = ["D0", "D1", "D2"];

const CLASS_LABELS: Record<string, string> = {
  D0: "Public only (nothing about your pharmacy's business)",
  D1: "Internal (stock and sales figures; no customer or supplier names)",
  D2: "Confidential (names, prices and other identifying detail)",
};

export const tenantClassLabel = (cls: string): string => CLASS_LABELS[cls] ?? cls;

export const TENANT_LIMIT_LOAD_FAILED = "Couldn't load the pharmacy's AI data limit.";

export function historyEntryText(entry: Pick<TenantAiLimitView["history"][number], "maxClass" | "at" | "byYou">): string {
  return `${tenantClassLabel(entry.maxClass)} · ${formatDate(entry.at)} · by ${entry.byYou ? "you" : "a colleague"}`;
}

/** Why a change was not made (the route's answers, spec 9.3 and 9.4). A 403 from a pharmacy that cannot open carries its own message. */
export function changeFailureText(status: number, message: string): string {
  if (status === 409) {
    return "The limit can't be raised yet. Raising it needs an AI provider that Oneon has fully reviewed, that holds a signed data processing agreement and that is cleared for this level. You can always lower it.";
  }
  if (status === 403 && message === "permission_required") {
    return "Only a pharmacy administrator can change this. Your access in ImpressoRx doesn't include managing Oneon. Nothing was changed.";
  }
  if (status === 403 && message.trim().length > 0) return message;
  if (status === 503) return "Oneon can't reach ImpressoRx right now, so it can't check your access. Nothing was changed. Try again in a moment.";
  return "Couldn't change the limit. Nothing was changed. Try again.";
}
