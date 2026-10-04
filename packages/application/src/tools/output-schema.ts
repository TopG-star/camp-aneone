import type { ClassifiedField, ClassifiedRow, DataClass, PromptPart } from "../ai-boundary/types.js";

export interface ToolFieldSpec {
  class: DataClass;
  freeText?: boolean;
  entity?: "person" | "customer" | "supplier";
}

export interface ToolOutputSchema {
  fields: Record<string, ToolFieldSpec>;
  /** D2 whenever the summary echoes a model-supplied parameter: a restored placeholder would come back as the real value. */
  summaryClass: DataClass;
  /** When data is an object holding the list, the key of that list; the other top-level keys form one extra row. */
  rowsFrom?: string;
  rowClass?: (row: Record<string, unknown>) => DataClass | undefined;
}

const D1: ToolFieldSpec = { class: "D1" };
const D2: ToolFieldSpec = { class: "D2" };
const FREE: ToolFieldSpec = { class: "D2", freeText: true };

export const EMAIL_ENTRY_FIELDS: Record<string, ToolFieldSpec> = {
  id: D1, subject: FREE, from: { class: "D2", entity: "person" }, source: D1, receivedAt: D1, category: D1, priority: D1, summary: FREE,
};
export const CALENDAR_EVENT_FIELDS: Record<string, ToolFieldSpec> = {
  id: D1, start: D1, end: D1, allDay: D1, etag: D1, updated: D1, title: FREE, description: FREE, attendees: D2, location: D2,
};
export const TRANSACTION_FIELDS: Record<string, ToolFieldSpec> = {
  id: D1, statementId: D1, userId: D1, postedAt: D1, dedupeKey: FREE, createdAt: D1, description: FREE, amountMinor: D2, balanceMinor: D2,
};

function toRow(item: unknown, schema: ToolOutputSchema): ClassifiedRow {
  const obj = item !== null && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : { value: item };
  const fields: ClassifiedField[] = Object.entries(obj).map(([name, value]) => {
    const spec = Object.hasOwn(schema.fields, name) ? schema.fields[name] : undefined;
    if (!spec) return { name, class: null, value };
    return {
      name,
      class: spec.class,
      value,
      ...(spec.freeText ? { freeText: true } : {}),
      ...(spec.entity && typeof value === "string" ? { entity: { type: spec.entity, id: value } } : {}),
    };
  });
  const rowClass = schema.rowClass?.(obj);
  return rowClass ? { rowClass, fields } : { fields };
}

export function toolResultToRecord(
  tool: string,
  schema: ToolOutputSchema,
  result: { data: unknown; summary: string },
): Extract<PromptPart, { kind: "record" }> {
  const rows: ClassifiedRow[] = [];
  const data = result.data;
  if (Array.isArray(data)) rows.push(...data.map((item) => toRow(item, schema)));
  else if (data !== null && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (schema.rowsFrom && Array.isArray(obj[schema.rowsFrom])) {
      rows.push(...(obj[schema.rowsFrom] as unknown[]).map((item) => toRow(item, schema)));
      const rest = Object.fromEntries(Object.entries(obj).filter(([k]) => k !== schema.rowsFrom));
      if (Object.keys(rest).length > 0) rows.push(toRow(rest, schema));
    } else rows.push(toRow(obj, schema));
  }
  // A summary is prose that can quote parameters, subjects or titles, so it is always scanned free text; its class is declared per tool.
  rows.push({ fields: [{ name: "summary", class: schema.summaryClass, value: result.summary, freeText: true }] });
  return { kind: "record", source: `tool:${tool}`, rows };
}
