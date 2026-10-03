import { describe, it, expect } from "vitest";
import { STATUS_GROUPS } from "@oneon/contracts";
import {
  GROUP_BADGE, GROUP_FILTERS, actionsQuery, actorLabel, chatChip, evidenceSummary, operationLabel, statusLabel, undoNote, verifyingNote,
} from "./action-ui";

describe("action UI helpers", () => {
  it("colours every group by one rule (spec §13.1)", () => {
    expect(GROUP_BADGE).toEqual({ needs_you: "warning", in_progress: "info", done: "success", problem: "error", closed: "default" });
    expect(GROUP_FILTERS.map((f) => f.label)).toEqual(["Needs you", "In progress", "Done", "Problem", "Closed", "All", "Legacy (MVP1)"]);
  });

  it("labels all 15 statuses", () => {
    for (const status of Object.values(STATUS_GROUPS).flat()) expect(statusLabel(status)).not.toBe(status);
    expect(statusLabel("rollback_failed")).toBe("Undo failed");
  });

  it("builds list queries; legacy uses its own endpoint", () => {
    expect(actionsQuery("needs_you", 0, 25)).toBe("limit=25&offset=0&group=needs_you");
    expect(actionsQuery("all", 25, 25)).toBe("limit=25&offset=25");
    expect(actionsQuery("legacy", 0, 25)).toBeNull();
  });

  it("summarises evidence by kind", () => {
    expect(evidenceSummary({ kind: "rule", source: "oneon:inbox-rules", asOf: "", data: { ruleId: "inbox.urgent_notify", condition: "priority <= 2", values: { priority: 1 } } })).toEqual({
      title: "Rule",
      lines: ["inbox.urgent_notify: priority <= 2", "priority = 1"],
    });
    expect(evidenceSummary({ kind: "chat_turn", source: "chat", asOf: "", data: { excerpt: "set up a call", model: "anthropic:claude" } })).toEqual({
      title: "Chat",
      lines: ['"set up a call"', "Model: anthropic:claude"],
    });
  });

  it("names actors and operations in plain words", () => {
    expect(actorLabel({ kind: "sweeper" })).toBe("Recovery");
    expect(actorLabel({ kind: "policy" })).toBe("Oneon policy");
    expect(operationLabel("retry")).toBe("Try again");
  });

  it("links chat chips to the action", () => {
    expect(chatChip({ id: "a1", actionType: "create_calendar_event", label: "Create calendar event", status: "awaiting_approval" })).toEqual({
      href: "/actions#action-a1",
      text: "Waiting for approval · Open",
    });
    expect(chatChip({ id: "a2", actionType: "x", label: "x", status: "completed" }).text).toBe("Done · Open");
  });

  it("explains an unconfirmed outcome with the last verification attempt's time", () => {
    const at = new Date("2026-10-01T12:09:00.000Z").toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    expect(verifyingNote({ lastCheckedAt: "2026-10-01T12:09:00.000Z" } as never)).toBe(
      `Couldn't confirm yet; Oneon will check again automatically (last checked ${at}).`,
    );
    expect(verifyingNote({ lastCheckedAt: null } as never)).toBeNull();
  });

  it("shows the undo line only when the view has one (I3)", () => {
    const undo = (text: string | null) => ({ rollbackClass: "reversible" as const, text, warning: null });
    expect(undoNote({ undo: undo(null), attemptNumber: 1 })).toBeNull();
    expect(undoNote({ undo: undo("Can be undone"), attemptNumber: 1 })).toBe("Can be undone");
    expect(undoNote({ undo: undo("Can be undone"), attemptNumber: 2 })).toBe("Can be undone · Attempt 2");
    expect(undoNote({ undo: undo(null), attemptNumber: 3 })).toBe("Attempt 3");
  });
});
