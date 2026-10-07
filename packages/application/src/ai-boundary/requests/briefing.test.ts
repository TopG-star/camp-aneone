import { describe, it, expect } from "vitest";
import { buildBriefingRequest } from "./briefing.js";
import { decide } from "../decide.js";
import { PROVIDER_REGISTRY } from "../providers.js";

const data = {
  date: "2026-10-03",
  urgentItems: [{ id: "i1", subject: "Outage", from: "ops@x.com", source: "gmail", category: "urgent", priority: 1, summary: "Prod down" }],
  deadlines: [],
  pendingActions: [{ actionType: "notify", resourceId: "inbound_item:i1", riskLevel: "L1" }],
  calendar: { status: "connected" as const, events: [] },
};

describe("buildBriefingRequest", () => {
  it("builds the five records with their classes", () => {
    const req = buildBriefingRequest(data as never);
    expect(req).toMatchObject({ purpose: "daily_briefing", output: "text" });
    expect(req.parts.map((p) => (p as { source: string }).source)).toEqual(["briefing_meta", "urgent_items", "deadlines", "calendar", "pending_actions"]);
  });
  it("is denied at D1 because every section loses its descriptive fields (spec §10.3), and allowed at D2", () => {
    const run = (choiceLimit: "D1" | "D2") =>
      decide({ context: { kind: "personal", identityId: "u1" }, request: buildBriefingRequest(data as never), provider: { entry: PROVIDER_REGISTRY.deepseek }, choiceLimit });
    expect(run("D1")).toMatchObject({ kind: "deny", reason: "required_part_withheld" });
    expect(run("D2").kind).toBe("allow");
  });
  it("leaves out null calendar location and description instead of sending them", () => {
    const event = { id: "e", title: "Standup", start: "s", end: "e", allDay: false, description: null, attendees: ["a@x.com"], location: null };
    const req = buildBriefingRequest({ ...data, calendar: { status: "connected", events: [event] } } as never);
    const calendar = req.parts.find((p) => (p as { source?: string }).source === "calendar") as { rows: { fields: { name: string }[] }[] };
    expect(calendar.rows[0].fields.map((f) => f.name)).toEqual(["start", "end", "allDay", "title", "attendees"]);
  });
});
