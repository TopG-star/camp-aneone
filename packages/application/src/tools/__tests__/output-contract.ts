import { expect } from "vitest";
import type { ToolDefinition, ToolResult } from "../tool-registry.js";
import { toolResultToRecord } from "../output-schema.js";

/** Spec §12: a tool's real output must contain only declared fields, with entity and free-text values as strings. */
export function expectMatchesOutputSchema(tool: ToolDefinition, result: ToolResult): void {
  const record = toolResultToRecord(tool.name, tool.output, result);
  for (const row of record.rows) {
    for (const f of row.fields) {
      expect(f.class, `${tool.name}.${f.name} is not declared in its output schema`).not.toBeNull();
      if (f.entity) expect(typeof f.value, `${tool.name}.${f.name} is an entity and must be a string`).toBe("string");
      if (f.freeText && f.value !== null) expect(typeof f.value, `${tool.name}.${f.name} is free text and must be a string`).toBe("string");
    }
  }
}
