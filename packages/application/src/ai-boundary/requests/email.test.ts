import { describe, it, expect } from "vitest";
import { emailClassificationRequest } from "./email.js";
import { decide } from "../decide.js";
import { PROVIDER_REGISTRY } from "../providers.js";

const item = { from: "ama@x.com", subject: "Invoice", bodyPreview: "Pay by Friday", receivedAt: "2026-10-03T09:00:00Z", source: "gmail" as const };

describe("emailClassificationRequest", () => {
  it("sends exactly the five declared fields with their classes", () => {
    const req = emailClassificationRequest(item);
    expect(req).toMatchObject({ purpose: "email_classification", output: "json" });
    const fields = (req.parts[0] as { rows: Array<{ fields: Array<{ name: string; class: string }> }> }).rows[0].fields;
    expect(fields.map((f) => [f.name, f.class])).toEqual([
      ["from", "D2"],
      ["subject", "D2"],
      ["bodyPreview", "D2"],
      ["receivedAt", "D1"],
      ["source", "D0"],
    ]);
  });
  it("is allowed after a D2 opt-in and denied at the D1 default", () => {
    const run = (choiceLimit: "D1" | "D2") =>
      decide({ context: { kind: "personal", identityId: "u1" }, request: emailClassificationRequest(item), provider: { entry: PROVIDER_REGISTRY.deepseek }, choiceLimit }).kind;
    expect(run("D2")).toBe("allow");
    expect(run("D1")).toBe("deny");
  });
});
