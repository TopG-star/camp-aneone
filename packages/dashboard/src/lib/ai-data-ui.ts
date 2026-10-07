const CLASS_LABELS: Record<string, string> = { D1: "Basic (no names or message content)", D2: "Includes names and message content" };
const PURPOSE_LABELS: Record<string, string> = {
  email_classification: "Email sorting",
  intent_extraction: "Chat: choosing tools",
  chat_reply: "Chat: writing the reply",
  daily_briefing: "Daily briefing",
};

export const classLabel = (cls: string): string => CLASS_LABELS[cls] ?? cls;
export const purposeLabel = (purpose: string): string => PURPOSE_LABELS[purpose] ?? purpose;

export function callLabel(call: { decision: "allow" | "deny"; outcome: "answered" | "blocked" | "failed" | null; denyReason: string | null }): string {
  if (call.decision === "deny") return `Not sent: ${call.denyReason ?? "policy"}`;
  if (call.outcome === "answered") return "Sent";
  if (call.outcome === "blocked") return "Answer blocked";
  if (call.outcome === "failed") return "Provider error";
  return "Sent";
}

export function routingWarningText(warning: { role: string; provider: string }, label: string): string {
  return `${label} is set as the ${warning.role} AI provider but has no API key, so its requests are refused.`;
}

export function pendingDecisionText(decision: { decidedOn: string }, label: string): string {
  const date = new Date(`${decision.decidedOn}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return `On ${date} you approved ${label} receiving your personal email content until this setting existed. Check ${label}'s current terms, then confirm or keep the basic level.`;
}
