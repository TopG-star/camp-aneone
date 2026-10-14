import { describe, it, expect } from "vitest";
import { OverrideConfigError, PROVIDER_REGISTRY, explainProviderLimit, parseProviderOverrides, providerLimit, type ProviderEntry } from "./providers.js";

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
  describe("a pharmacy's data above D1 (spec 9.4)", () => {
    const dpa = { signedOn: "2026-09-30", reference: "DPA-1" };
    const d2 = (over: Partial<ProviderEntry> = {}): ProviderEntry => ({ ...deepseek, limits: { personal: "D2", tenant: "D2" }, ...over });

    it("caps a provider at D1 unless it is reviewed and holds a DPA, whatever its registry limit", () => {
      expect(providerLimit(d2(), "tenant")).toBe("D1");
      expect(providerLimit(d2({ review: "reviewed" }), "tenant")).toBe("D1");
      expect(providerLimit(d2({ review: "reviewed", tenantDpa: null }), "tenant")).toBe("D1");
      expect(providerLimit(d2({ tenantDpa: dpa }), "tenant")).toBe("D1");
    });
    it("lets a reviewed provider with a DPA reach its registry limit, which an override can still lower", () => {
      expect(providerLimit(d2({ review: "reviewed", tenantDpa: dpa }), "tenant")).toBe("D2");
      expect(providerLimit(d2({ review: "reviewed", tenantDpa: dpa }), "tenant", { kind: "limit", max: "D0" })).toBe("D0");
      expect(providerLimit(d2({ review: "reviewed", tenantDpa: dpa }), "tenant", { kind: "suspended" })).toBe("suspended");
    });
    it("never raises a limit that is already below D1", () => {
      expect(providerLimit(d2({ limits: { personal: "D2", tenant: "D0" } }), "tenant")).toBe("D0");
    });
    it("leaves a person's own data alone: personal limits do not depend on review or a DPA", () => {
      expect(providerLimit(d2(), "personal")).toBe("D2");
    });
  });
  it("reports suspended and unknown providers", () => {
    expect(providerLimit(deepseek, "personal", { kind: "suspended" })).toBe("suspended");
    expect(providerLimit(undefined, "personal")).toBe("unknown");
  });
});

describe("explainProviderLimit (spec 9.4: the admin screen says why a provider gets less)", () => {
  const deepseek = PROVIDER_REGISTRY.deepseek;
  const dpa = { signedOn: "2026-09-30", reference: "DPA-1" };
  const d2 = (over: Partial<ProviderEntry> = {}): ProviderEntry => ({ ...deepseek, limits: { personal: "D2", tenant: "D2" }, ...over });
  const cleared = d2({ review: "reviewed", tenantDpa: dpa });

  it("names the layer that sets each limit", () => {
    expect(explainProviderLimit(d2(), "tenant")).toEqual({ limit: "D1", cap: "not_cleared" });
    expect(explainProviderLimit(cleared, "tenant")).toEqual({ limit: "D2", cap: "registry" });
    expect(explainProviderLimit(cleared, "tenant", { kind: "limit", max: "D1" })).toEqual({ limit: "D1", cap: "override" });
    expect(explainProviderLimit(d2({ limits: { personal: "D2", tenant: "D0" } }), "tenant")).toEqual({ limit: "D0", cap: "registry" });
    expect(explainProviderLimit(cleared, "tenant", { kind: "suspended" })).toEqual({ limit: "suspended", cap: "suspended" });
    expect(explainProviderLimit(undefined, "tenant")).toEqual({ limit: "unknown", cap: "unknown" });
  });
  it("today's providers (registry D1 for pharmacies, unreviewed, no DPA) are held at D1 because they are not cleared", () => {
    expect(explainProviderLimit(deepseek, "tenant")).toEqual({ limit: "D1", cap: "not_cleared" });
    expect(explainProviderLimit(PROVIDER_REGISTRY.anthropic, "tenant")).toEqual({ limit: "D1", cap: "not_cleared" });
  });
  it("an override that lowers no further than the other layers is not the reason", () => {
    expect(explainProviderLimit(d2(), "tenant", { kind: "limit", max: "D1" })).toEqual({ limit: "D1", cap: "not_cleared" });
    expect(explainProviderLimit(d2(), "tenant", { kind: "limit", max: "D0" })).toEqual({ limit: "D0", cap: "override" });
  });
  it("is the limit providerLimit returns, the one the gateway applies, for every combination", () => {
    const entries = [undefined, deepseek, d2(), cleared, d2({ limits: { personal: "D1", tenant: "D0" } })];
    const overrides = [undefined, { kind: "suspended" as const }, ...(["D0", "D1", "D2"] as const).map((max) => ({ kind: "limit" as const, max }))];
    for (const entry of entries) for (const kind of ["personal", "tenant"] as const) for (const override of overrides) {
      expect(explainProviderLimit(entry, kind, override).limit).toBe(providerLimit(entry, kind, override));
    }
  });
});
