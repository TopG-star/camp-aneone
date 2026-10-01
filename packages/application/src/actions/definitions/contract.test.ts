import { describe, it, expect } from "vitest";
import { createActionDefinitions } from "./index.js";
import { clampPolicy } from "../policy/index.js";

// A valid input per definition. Tasks 7 and 8 add entries.
const SAMPLES: Record<string, Record<string, unknown>> = {
  archive: { inboundItemId: "i1", reason: "spam_classification" },
  label: { inboundItemId: "i1", label: "newsletter", reason: "newsletter_low_priority" },
  draft_reply: { inboundItemId: "i1", reason: "follow_up_needed", summary: "s", from: "a@x.com" },
  delete: { inboundItemId: "i1", reason: "user_request" },
  send: { inboundItemId: "i1", to: ["a@x.com"], subject: "Re: hi", body: "Thanks" },
  forward: { inboundItemId: "i1", to: ["a@x.com"] },
};

const IDENTITY_KEYS = ["tenantId", "tenant", "ownerId", "userId"];

describe.each(createActionDefinitions().map((d) => [d.type, d] as const))("definition %s", (type, def) => {
  it("has a sample", () => {
    expect(SAMPLES[type], `add a sample for ${type}`).toBeDefined();
  });

  it("accepts its sample and rejects unknown keys (strict schema)", () => {
    expect(def.inputSchema.safeParse(SAMPLES[type]).success).toBe(true);
    expect(def.inputSchema.safeParse({ ...SAMPLES[type], unexpected: true }).success).toBe(false);
  });

  it("does not accept identity keys from input", () => {
    for (const key of IDENTITY_KEYS) {
      expect(def.inputSchema.safeParse({ ...SAMPLES[type], [key]: "x" }).success, key).toBe(false);
    }
  });

  it("has defaults that already satisfy its floor", () => {
    const result = clampPolicy({
      floor: def.floor,
      defaults: def.defaults,
      storedJson: null,
      declaredMetrics: Object.keys(def.thresholdMetrics),
      executorAvailable: def.execute !== null,
    });
    expect(result.clamped).toEqual([]);
  });

  it("is unavailable exactly when it has no executor", () => {
    expect(def.execute === null).toBe(def.unavailableReason !== null);
  });
});

describe("Gmail definitions", () => {
  it.each([
    ["archive", "needs Gmail modify access (gmail.modify)", "L1", "auto", "reversible"],
    ["label", "needs Gmail modify access (gmail.modify)", "L1", "auto", "reversible"],
    ["draft_reply", "needs Gmail compose access (gmail.compose)", "L1", "auto", "reversible"],
    ["delete", "needs Gmail modify access (gmail.modify)", "L3", "always", "irreversible"],
    ["send", "needs Gmail send access (gmail.send)", "L3", "always", "irreversible"],
    ["forward", "needs Gmail send access (gmail.send)", "L3", "always", "irreversible"],
  ])("%s: %s, floor %s / %s, %s", (type, reason, risk, mode, rollback) => {
    const def = createActionDefinitions().find((d) => d.type === type)!;
    expect(def).toMatchObject({ unavailableReason: reason, rollbackClass: rollback, execute: null });
    expect(def.floor.risk).toBe(risk);
    expect(def.floor.approval.mode).toBe(mode);
  });
});
