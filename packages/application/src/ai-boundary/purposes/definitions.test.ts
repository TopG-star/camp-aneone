import { describe, it, expect } from "vitest";
import { MIN_GROUP_SIZE, PURPOSES, allowedFieldsFor } from "./definitions.js";
import { MODEL_PURPOSES } from "../types.js";

describe("purposes", () => {
  it("defines exactly the four day-one purposes, each capped at D2", () => {
    expect(Object.keys(PURPOSES).sort()).toEqual([...MODEL_PURPOSES].sort());
    for (const def of Object.values(PURPOSES)) expect(def.limit).toBe("D2");
  });

  it("never lowers the minimum aggregate group size below 5", () => {
    for (const def of Object.values(PURPOSES)) expect(def.minGroupSize).toBeGreaterThanOrEqual(MIN_GROUP_SIZE);
  });

  it("tells intent extraction and synthesis that a truncated field means a partial list", () => {
    for (const p of ["intent_extraction", "chat_reply"] as const) {
      expect(PURPOSES[p].instructions).toContain(
        "A record field named truncated means the list is partial: conclusions about the whole list must say so.",
      );
    }
  });

  it("allows exactly the five email fields for classification, and requires the body preview released", () => {
    expect(allowedFieldsFor(PURPOSES.email_classification, "email")).toEqual(["from", "subject", "bodyPreview", "receivedAt", "source"]);
    expect(PURPOSES.email_classification.required).toEqual({ all: ["record:email#bodyPreview"] });
  });

  it("lets chat purposes take any declared tool field, and nothing from unknown sources", () => {
    expect(allowedFieldsFor(PURPOSES.chat_reply, "tool:list_inbox")).toBe("declared");
    expect(allowedFieldsFor(PURPOSES.chat_reply, "unknown_source")).toBeNull();
  });

  it("requires at least one briefing section's content, not all of them (spec §10.1)", () => {
    expect(PURPOSES.daily_briefing.required).toEqual({
      anyOf: ["record:urgent_items#subject", "record:urgent_items#summary", "record:deadlines#description", "record:calendar#title"],
    });
  });

  it("restores names in every answer except intent extraction, whose tokens become tool parameters", () => {
    expect(PURPOSES.intent_extraction.restoreNames).toBe(false);
    expect(PURPOSES.chat_reply.restoreNames).toBe(true);
    expect(PURPOSES.daily_briefing.restoreNames).toBe(true);
    expect(PURPOSES.email_classification.restoreNames).toBe(true);
  });

  it("validates classification output with the shared schema", () => {
    const good = { category: "work", priority: 2, summary: "s", actionItems: [], followUpNeeded: false, deadlines: [] };
    expect(PURPOSES.email_classification.outputSchema!.safeParse(good).success).toBe(true);
    expect(PURPOSES.email_classification.outputSchema!.safeParse({ ...good, priority: 9 }).success).toBe(false);
  });
});
