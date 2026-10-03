import { describe, it, expect } from "vitest";
import { OverrideConfigError, PROVIDER_REGISTRY, parseProviderOverrides, providerLimit } from "./providers.js";

describe("provider registry", () => {
  it("starts every provider unreviewed: personal D2, tenant D1 (spec §2.6)", () => {
    for (const entry of Object.values(PROVIDER_REGISTRY)) {
      expect(entry).toMatchObject({ review: "unreviewed", limits: { personal: "D2", tenant: "D1" } });
    }
  });
});

describe("parseProviderOverrides", () => {
  it("treats an empty or missing value as no overrides", () => {
    expect(parseProviderOverrides(undefined).size).toBe(0);
    expect(parseProviderOverrides("  ").size).toBe(0);
  });

  it("parses suspensions and lowered limits", () => {
    const o = parseProviderOverrides("deepseek:suspended,anthropic:D1");
    expect(o.get("deepseek")).toEqual({ kind: "suspended" });
    expect(o.get("anthropic")).toEqual({ kind: "limit", max: "D1" });
  });

  it("tolerates whitespace and case (Review Focus 5)", () => {
    const o = parseProviderOverrides(" DeepSeek : Suspended , anthropic:d1 ");
    expect(o.get("deepseek")).toEqual({ kind: "suspended" });
    expect(o.get("anthropic")).toEqual({ kind: "limit", max: "D1" });
  });

  it.each([
    ["deepseek", "malformed entry"],
    ["deepseek:", "malformed entry"],
    ["deepsek:suspended", "unknown provider"],
    ["deepseek:off", "unknown value"],
    ["deepseek:D3", "would raise"],
    ["deepseek:D4", "would raise"],
    ["deepseek:D1,deepseek:D0", "listed twice"],
  ])("refuses %s (%s), so a typo can never silently change policy", (raw, message) => {
    expect(() => parseProviderOverrides(raw)).toThrow(OverrideConfigError);
    expect(() => parseProviderOverrides(raw)).toThrow(message);
  });
});

describe("providerLimit", () => {
  const deepseek = PROVIDER_REGISTRY.deepseek;
  it("uses the registry limit for the context", () => {
    expect(providerLimit(deepseek, "personal")).toBe("D2");
    expect(providerLimit(deepseek, "tenant")).toBe("D1");
  });
  it("lowers but never raises with an override", () => {
    expect(providerLimit(deepseek, "personal", { kind: "limit", max: "D1" })).toBe("D1");
    expect(providerLimit(deepseek, "tenant", { kind: "limit", max: "D2" })).toBe("D1");
  });
  it("reports suspended and unknown providers", () => {
    expect(providerLimit(deepseek, "personal", { kind: "suspended" })).toBe("suspended");
    expect(providerLimit(undefined, "personal")).toBe("unknown");
  });
});
