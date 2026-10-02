import { describe, it, expect } from "vitest";
import type { Classification, Deadline, InboundItem } from "@oneon/domain";
import { deriveInboxActionRequests } from "./inbox-rules.js";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const item = { id: "i1", from: "boss@co.com", subject: "Q4 numbers", receivedAt: "2026-10-01T11:00:00Z", source: "gmail" } as InboundItem;
const cls = (over: Partial<Classification> = {}) =>
  ({ category: "work", priority: 3, summary: "Needs numbers", followUpNeeded: false, model: "claude-haiku", promptVersion: "v1", ...over }) as Classification;
const dl = (over: Partial<Deadline> = {}) => ({ id: "d1", confidence: 0.9, dueDate: "2026-10-07T17:00:00Z", description: "Send Q4", ...over }) as Deadline;

const types = (reqs: ReturnType<typeof deriveInboxActionRequests>) => reqs.map((r) => r.type);

describe("deriveInboxActionRequests", () => {
  it("requests notify only at priority ≤ 2", () => {
    expect(types(deriveInboxActionRequests({ classification: cls({ priority: 2 }), item, deadlines: [], now: NOW }))).toEqual(["notify"]);
    expect(types(deriveInboxActionRequests({ classification: cls({ priority: 3, category: "urgent" }), item, deadlines: [], now: NOW }))).toEqual([]);
  });

  it("builds notify with today's title, link, evidence and key context", () => {
    const [notify] = deriveInboxActionRequests({ classification: cls({ priority: 1 }), item, deadlines: [], now: NOW });
    expect(notify).toMatchObject({
      type: "notify",
      input: { inboundItemId: "i1", title: "Urgent: Q4 numbers", body: "Needs numbers", deepLink: "/items/i1" },
      initiator: "rule:inbox.urgent_notify",
      keyContext: { source: "rule", resourceId: "i1" },
      resourceRef: "inbound_item:i1",
    });
    expect(notify.evidence.map((e) => e.kind)).toEqual(["rule", "classification", "email"]);
    expect(notify.evidence[0].data).toEqual({ ruleId: "inbox.urgent_notify", condition: "priority <= 2", values: { priority: 1 } });
  });

  it("requests a reminder per deadline at confidence ≥ 0.7", () => {
    const reqs = deriveInboxActionRequests({ classification: cls(), item, deadlines: [dl(), dl({ id: "d2", confidence: 0.69 })], now: NOW });
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({ type: "create_reminder", input: { deadlineId: "d1", inboundItemId: "i1" }, resourceRef: "deadline:d1" });
  });

  it("keeps the Gmail proposals", () => {
    expect(types(deriveInboxActionRequests({ classification: cls({ category: "spam" }), item, deadlines: [], now: NOW }))).toEqual(["archive"]);
    expect(types(deriveInboxActionRequests({ classification: cls({ category: "newsletter", priority: 4 }), item, deadlines: [], now: NOW }))).toEqual(["label"]);
    expect(types(deriveInboxActionRequests({ classification: cls({ followUpNeeded: true }), item, deadlines: [], now: NOW }))).toEqual(["draft_reply"]);
  });
});
