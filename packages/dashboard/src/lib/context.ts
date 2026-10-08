/** One entry of the context picker (GET /api/contexts). */
export type ContextOption =
  | { kind: "personal" }
  | { kind: "tenant"; membershipId: string; tenantName: string; role: string };

export interface ContextsResponse {
  active: ContextOption;
  available: ContextOption[];
}

/** What the person asks to switch to; the same shape the agent-server validates. */
export type ContextChoice = { kind: "personal" } | { kind: "tenant"; membershipId: string };

/**
 * The 403 codes of a context that cannot open (the agent-server's active-context middleware and validate call). Each
 * carries a `message` for the person, and neither means "sign in again".
 */
const CONTEXT_REFUSALS = new Set(["launch_required", "membership_suspended"]);

export function isContextRefusal(code: unknown): boolean {
  return typeof code === "string" && CONTEXT_REFUSALS.has(code);
}

export function contextLabel(option: ContextOption): string {
  return option.kind === "personal" ? "Personal" : `${option.tenantName} · ${option.role}`;
}

export function contextValue(option: ContextOption): string {
  return option.kind === "personal" ? "personal" : `tenant:${option.membershipId}`;
}

export function contextChoice(option: ContextOption): ContextChoice {
  return option.kind === "personal" ? { kind: "personal" } : { kind: "tenant", membershipId: option.membershipId };
}

/** The available contexts, plus the current one when the server no longer offers it (a suspended pharmacy). */
export function pickerOptions({ active, available }: ContextsResponse): ContextOption[] {
  return available.some((o) => contextValue(o) === contextValue(active)) ? available : [active, ...available];
}

/** A person who works only in the personal context (no pharmacy) has nothing to pick, so the picker stays out of the way. */
export function pickerVisible(response: ContextsResponse): boolean {
  return pickerOptions(response).some((o) => o.kind === "tenant");
}

/**
 * Whether the context a session now holds (`session.activeContext` after `update()`) is the one that was requested.
 * A session with no context is personal. False means the switch was refused and the session kept its old context.
 */
export function choiceApplied(current: unknown, wanted: ContextChoice): boolean {
  const held = current === undefined ? ({ kind: "personal" } as const) : parseContextChoice(current);
  if (!held) return false;
  return held.kind === wanted.kind && (held.kind === "personal" || (wanted.kind === "tenant" && held.membershipId === wanted.membershipId));
}

/** Only the two shapes the agent-server validates; anything else, and any extra field, is dropped. */
export function parseContextChoice(value: unknown): ContextChoice | null {
  if (typeof value !== "object" || value === null) return null;
  const { kind, membershipId } = value as { kind?: unknown; membershipId?: unknown };
  if (kind === "personal") return { kind: "personal" };
  if (kind === "tenant" && typeof membershipId === "string" && membershipId.length > 0) return { kind: "tenant", membershipId };
  return null;
}
