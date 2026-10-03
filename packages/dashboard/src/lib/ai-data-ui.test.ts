import { describe, it, expect } from "vitest";
import { callLabel, classLabel, pendingDecisionText, purposeLabel } from "./ai-data-ui";

describe("AI data UI helpers", () => {
  it("labels classes and purposes in plain words", () => {
    expect(classLabel("D1")).toBe("Basic (no names or message content)");
    expect(classLabel("D2")).toBe("Includes names and message content");
    expect(purposeLabel("chat_reply")).toBe("Chat: writing the reply");
    expect(purposeLabel("something_new")).toBe("something_new");
  });
  it("labels call outcomes, including denials with their reason", () => {
    expect(callLabel({ decision: "allow", outcome: "answered", denyReason: null })).toBe("Sent");
    expect(callLabel({ decision: "deny", outcome: null, denyReason: "required_part_withheld" })).toBe("Not sent: required_part_withheld");
    expect(callLabel({ decision: "allow", outcome: "blocked", denyReason: null })).toBe("Answer blocked");
  });
  it("words the pending decision with its date and provider", () => {
    expect(pendingDecisionText({ decidedOn: "2026-10-03" }, "DeepSeek")).toBe(
      "On 3 Oct 2026 you approved DeepSeek receiving your personal email content until this setting existed. Check DeepSeek's current terms, then confirm or keep the basic level.",
    );
  });
});
