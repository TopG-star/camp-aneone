import type { Instruction } from "./instruction.js";

/** Spec §4: one sensitivity scale, lowest to highest. Separate from action risk tiers L0–L4. */
export const DATA_CLASSES = ["D0", "D1", "D2", "D3", "D4"] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

export const classRank = (c: DataClass): number => DATA_CLASSES.indexOf(c);
export const higherClass = (a: DataClass, b: DataClass): DataClass => (classRank(a) >= classRank(b) ? a : b);
export const lowerClass = (a: DataClass, b: DataClass): DataClass => (classRank(a) <= classRank(b) ? a : b);
export const isDataClass = (v: unknown): v is DataClass =>
  typeof v === "string" && (DATA_CLASSES as readonly string[]).includes(v);

export const PROVIDER_IDS = ["deepseek", "anthropic"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** Built by the server, never by the model (spec §5.1). The tenant shape is assumed until Step B. */
export type ModelContext =
  | { kind: "personal"; identityId: string }
  | { kind: "tenant"; identityId: string; tenantId: string; membershipId: string };

export const MODEL_PURPOSES = ["email_classification", "intent_extraction", "chat_reply", "daily_briefing"] as const;
export type ModelPurpose = (typeof MODEL_PURPOSES)[number];

export interface EntityRef {
  /** Uppercased into the placeholder prefix: "customer" → CUSTOMER_1. */
  type: string;
  id: string;
}

/** A value computed over `count` records; it may count as `classIfSafe` only when count ≥ the purpose's minimum group size. */
export interface AggregateMark {
  count: number;
  classIfSafe: DataClass;
}

export interface ClassifiedField {
  name: string;
  /** null = unclassified: withheld with an alert (rule F2). */
  class: DataClass | null;
  /** Free text is scanned and never placeholder-able. */
  freeText?: boolean;
  value: unknown;
  /** A structured identifier that may be replaced by a placeholder (rule F5). */
  entity?: EntityRef;
  aggregate?: AggregateMark;
}

export interface ClassifiedRow {
  /** A floor for every field in the row; D3 withholds the row (F0), D4 denies the call (C4). */
  rowClass?: DataClass;
  fields: ClassifiedField[];
}

export interface HistoryTurn {
  role: "user" | "assistant";
  text: string;
}

export interface ToolDescriptor {
  name: string;
  description: string;
}

export type PromptPart =
  | { kind: "instruction"; text: Instruction }
  | { kind: "tool_catalog"; tools: ToolDescriptor[] }
  | { kind: "user_message"; text: string }
  | { kind: "history"; turns: HistoryTurn[] }
  | { kind: "record"; source: string; rows: ClassifiedRow[] };

export type PartKind = PromptPart["kind"];

export interface ModelRequest {
  /** A string, not ModelPurpose, so an unknown purpose can be represented and denied (rule C1). */
  purpose: string;
  output: "json" | "text";
  parts: PromptPart[];
}

/** How purposes name a part in required/allowed lists: records by source, everything else by kind. */
export function partKey(part: PromptPart): string {
  return part.kind === "record" ? `record:${part.source}` : part.kind;
}
