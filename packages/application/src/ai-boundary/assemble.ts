import type { Decision, FieldDisposition, WithheldReason } from "./decide.js";
import type { PlaceholderMap } from "./placeholders.js";
import type { PurposeDefinition } from "./purposes/index.js";
import { removeSpans } from "./scanner.js";
import type { ModelRequest } from "./types.js";

export interface ReleasedShapeEntry {
  part: string;
  field: string;
  outcome: "sent" | "placeholder" | `aggregate(${number})` | `withheld:${WithheldReason}`;
}
export interface AssembledPrompt {
  system: string;
  user: string;
  released: ReleasedShapeEntry[];
  placeholderCount: number;
}

const render = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value) ?? "null");
const shape = (d: FieldDisposition, aggregateCount?: number): ReleasedShapeEntry["outcome"] =>
  d.kind === "withheld" ? `withheld:${d.reason}` : d.kind === "aggregate" ? `aggregate(${aggregateCount ?? 0})` : d.kind;

export function assemblePrompt(
  request: ModelRequest,
  decision: Extract<Decision, { kind: "allow" }>,
  def: PurposeDefinition,
  map: PlaceholderMap,
): AssembledPrompt {
  const system: string[] = [def.instructions];
  const blocks: string[] = [];
  const released: ReleasedShapeEntry[] = [];
  const issued = new Set<string>();

  request.parts.forEach((part, p) => {
    const outcome = decision.parts[p];
    const disposition = outcome.disposition;
    // A part decide withheld whole (e.g. part_not_allowed) carries no turns or rows.
    if (disposition?.kind === "withheld") {
      released.push({ part: outcome.key, field: "*", outcome: shape(disposition) });
      return;
    }
    if (part.kind === "instruction") {
      if (disposition?.kind === "sent") system.push(part.text);
      return;
    }
    if (part.kind === "tool_catalog") {
      if (disposition?.kind === "sent") blocks.push(["=== TOOLS ===", ...part.tools.map((t) => `- ${t.name}: ${t.description}`)].join("\n"));
      return;
    }
    if (part.kind === "user_message") {
      released.push({ part: outcome.key, field: "*", outcome: shape(disposition!) });
      if (disposition?.kind === "sent") blocks.push(`=== USER MESSAGE ===\n${removeSpans(part.text, disposition.d3Spans ?? [])}`);
      return;
    }
    if (part.kind === "history") {
      const lines: string[] = [];
      part.turns.forEach((t, i) => {
        const d = outcome.turns![i];
        released.push({ part: outcome.key, field: `turn:${i}`, outcome: shape(d) });
        if (d.kind === "sent") lines.push(`[${t.role}]: ${removeSpans(t.text, d.d3Spans ?? [])}`);
      });
      if (lines.length > 0) blocks.push(["=== HISTORY ===", ...lines].join("\n"));
      return;
    }
    // record
    const lines: string[] = [];
    part.rows.forEach((r, ri) => {
      const rowOutcome = outcome.rows![ri];
      if (rowOutcome.withheld) {
        released.push({ part: outcome.key, field: `row:${ri}`, outcome: `withheld:${rowOutcome.withheld}` });
        return;
      }
      const cells: string[] = [];
      r.fields.forEach((f, fi) => {
        const d = rowOutcome.fields[fi];
        released.push({ part: outcome.key, field: f.name, outcome: shape(d, f.aggregate?.count) });
        if (d.kind === "placeholder") {
          const token = map.tokenFor(f.entity!, render(f.value));
          issued.add(token);
          cells.push(`${f.name}: ${token}`);
        }
        else if (d.kind === "sent") cells.push(`${f.name}: ${typeof f.value === "string" ? removeSpans(f.value, d.d3Spans ?? []) : render(f.value)}`);
        else if (d.kind === "aggregate") cells.push(`${f.name}: ${render(f.value)}`);
      });
      if (cells.length > 0) lines.push(`- ${cells.join(" | ")}`);
    });
    if (lines.length > 0) blocks.push([`=== ${part.source.toUpperCase()} ===`, ...lines].join("\n"));
  });

  const text = { system: system.join("\n\n"), user: blocks.join("\n\n") };
  // Per call, not per turn: the distinct tokens this call issued (the instruction text quotes example tokens, so the text is not counted).
  return { ...text, released, placeholderCount: issued.size };
}
