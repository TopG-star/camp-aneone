import { describe, it, expect } from "vitest";
import { describeActionError } from "./error-text.js";

const RAW_GOOGLE = 'Google Calendar API error 400: {"error":{"code":400,"message":"Invalid start time."}}';

describe("describeActionError", () => {
  it("never echoes the raw message or a bare code", () => {
    const text = describeActionError({ code: "rejected_by_google", message: RAW_GOOGLE, stage: "execution" }, "create_calendar_event");
    expect(text).toBe("Google Calendar refused the change, so nothing was changed.");
    expect(text).not.toMatch(/API error|rejected_by_google|\{/);
  });

  it.each([
    [{ code: "due_date_not_passed", stage: "validation" }, "create_reminder", "The due date has already passed, so Oneon didn't add the reminder."],
    [{ code: "calendar_connected", stage: "validation" }, "create_calendar_event", "Google Calendar isn't connected. Connect Google in Settings, then try again."],
    [{ code: "changed_since_approval", stage: "recheck" }, "update_calendar_event", "What this action would do changed after it was approved, so Oneon didn't run it. Try again to review the new version."],
    [{ code: "timeout", stage: "execution" }, "create_calendar_event", "Google didn't confirm the change in time. Oneon is checking whether it went through."],
    [{ code: "effect_absent", stage: "verification" }, "create_calendar_event", "Oneon checked and the change isn't there, so nothing was changed."],
  ])("maps %o to plain text", (error, type, text) => {
    expect(describeActionError({ ...error, message: "raw" } as never, type)).toBe(text);
  });

  it("says what is left to fix by hand when undo is refused (spec §10.6)", () => {
    expect(describeActionError({ code: "changed_since", message: "Undo refused: changed_since", stage: "undo" }, "create_calendar_event")).toBe(
      "Someone changed this event after Oneon created it, so Oneon left it alone. Delete it in Google Calendar if you still want it gone.",
    );
    expect(describeActionError({ code: "changed_since", message: "x", stage: "undo" }, "update_calendar_event")).toBe(
      "Someone changed this event after Oneon updated it, so Oneon left it alone. Change it back in Google Calendar if you still want the old details.",
    );
    expect(describeActionError({ code: "interrupted", message: "x", stage: "undo" }, "create_reminder")).toBe(
      "The undo was interrupted and Oneon couldn't confirm it. Check Google Calendar and delete the event if it's still there.",
    );
  });

  it("falls back to stage text for a code it does not know", () => {
    expect(describeActionError({ code: "mystery", message: RAW_GOOGLE, stage: "execution" }, "create_calendar_event")).toBe(
      "Oneon couldn't complete this action.",
    );
    expect(describeActionError({ code: "mystery", message: "x", stage: "undo" }, "update_calendar_event")).toBe(
      "Oneon couldn't undo this. Change it back in Google Calendar if you still want the old details.",
    );
  });
});
