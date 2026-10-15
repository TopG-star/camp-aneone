import { PROVIDER_IDS, classRank, isDataClass, type DataClass, type ProviderId } from "./types.js";

export interface ProviderEntry {
  id: ProviderId;
  label: string;
  /** The most this provider may ever receive, per context (spec §6.2). Raised only after a vendor review. */
  limits: { personal: DataClass; tenant: DataClass };
  review: "unreviewed" | "reviewed";
  /**
   * The signed data processing agreement with this provider for pharmacy data (spec 9.4). Pharmacy data goes above D1 only to a provider
   * that is reviewed and holds one of these (the gateway caps every other provider at D1 in a tenant context), and a pharmacy's limit
   * may be raised to D2 only while a configured provider is so cleared. Absent until signed.
   */
  tenantDpa?: { signedOn: string; reference: string } | null;
}

/** Oneon's AI processors. Changed only in code, by the platform (spec §2.7). */
export const PROVIDER_REGISTRY: Record<ProviderId, ProviderEntry> = {
  deepseek: { id: "deepseek", label: "DeepSeek", limits: { personal: "D2", tenant: "D1" }, review: "unreviewed" },
  anthropic: { id: "anthropic", label: "Anthropic", limits: { personal: "D2", tenant: "D1" }, review: "unreviewed" },
};

export type ProviderOverride = { kind: "suspended" } | { kind: "limit"; max: DataClass };

export class OverrideConfigError extends Error {
  constructor(message: string) {
    super(`MODEL_PROVIDER_OVERRIDES: ${message}`);
    this.name = "OverrideConfigError";
  }
}

/**
 * Parses MODEL_PROVIDER_OVERRIDES (spec §6.7). It may only suspend a provider or lower its limit.
 * Anything malformed, unknown, duplicated, or above the provider's highest registry limit throws,
 * which stops the server at startup.
 */
export function parseProviderOverrides(
  raw: string | undefined,
  registry: Record<ProviderId, ProviderEntry> = PROVIDER_REGISTRY,
): Map<ProviderId, ProviderOverride> {
  const result = new Map<ProviderId, ProviderOverride>();
  if (!raw || raw.trim() === "") return result;
  for (const entry of raw.split(",")) {
    const parts = entry.split(":").map((p) => p.trim());
    if (parts.length !== 2 || parts[0] === "" || parts[1] === "") throw new OverrideConfigError(`malformed entry "${entry.trim()}"`);
    const id = parts[0].toLowerCase();
    if (!(PROVIDER_IDS as readonly string[]).includes(id)) throw new OverrideConfigError(`unknown provider "${parts[0]}"`);
    const provider = id as ProviderId;
    if (result.has(provider)) throw new OverrideConfigError(`provider "${provider}" listed twice`);
    const value = parts[1].toUpperCase();
    if (value === "SUSPENDED") {
      result.set(provider, { kind: "suspended" });
      continue;
    }
    if (!isDataClass(value)) throw new OverrideConfigError(`unknown value "${parts[1]}" for "${provider}"`);
    const { personal, tenant } = registry[provider].limits;
    const highest = classRank(personal) >= classRank(tenant) ? personal : tenant;
    if (classRank(value) > classRank(highest)) {
      throw new OverrideConfigError(`"${provider}:${value}" would raise its limit above ${highest}; overrides can only lower`);
    }
    result.set(provider, { kind: "limit", max: value });
  }
  return result;
}

/**
 * Which layer sets a provider's limit (spec 9.4): its registry limit for the context; in a tenant context, the D1 hold on a provider that
 * is not reviewed with a tenant DPA (`not_cleared`); a platform override that lowers it further; or a suspended or unknown provider.
 */
export type ProviderLimitCap = "registry" | "not_cleared" | "override" | "suspended" | "unknown";

/**
 * The provider layer of the limit and the layer that sets it. `providerLimit` is its `limit`, so the gateway and the pharmacy's admin
 * screen read one computation. When the D1 hold and the registry limit are both D1, the hold is named: it is the one a review lifts.
 */
export function explainProviderLimit(
  entry: ProviderEntry | undefined,
  contextKind: "personal" | "tenant",
  override?: ProviderOverride,
): { limit: DataClass | "suspended" | "unknown"; cap: ProviderLimitCap } {
  if (!entry) return { limit: "unknown", cap: "unknown" };
  if (override?.kind === "suspended") return { limit: "suspended", cap: "suspended" };
  let limit = entry.limits[contextKind];
  let cap: ProviderLimitCap = "registry";
  // Spec 9.4: pharmacy data goes above D1 only to a provider that is fully reviewed and has a signed DPA recorded, whatever its registry
  // limit. Applied here, on every call and for every provider (shadow included), so it holds however the routing is changed.
  const cleared = entry.review === "reviewed" && !!entry.tenantDpa;
  if (contextKind === "tenant" && !cleared && classRank(limit) >= classRank("D1")) {
    limit = "D1";
    cap = "not_cleared";
  }
  if (override?.kind === "limit" && classRank(override.max) < classRank(limit)) {
    limit = override.max;
    cap = "override";
  }
  return { limit, cap };
}

export function providerLimit(
  entry: ProviderEntry | undefined,
  contextKind: "personal" | "tenant",
  override?: ProviderOverride,
): DataClass | "suspended" | "unknown" {
  return explainProviderLimit(entry, contextKind, override).limit;
}
