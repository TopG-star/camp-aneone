import { PROVIDER_IDS, classRank, isDataClass, lowerClass, type DataClass, type ProviderId } from "./types.js";

export interface ProviderEntry {
  id: ProviderId;
  label: string;
  /** The most this provider may ever receive, per context (spec §6.2). Raised only after a vendor review. */
  limits: { personal: DataClass; tenant: DataClass };
  review: "unreviewed" | "reviewed";
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

export function providerLimit(
  entry: ProviderEntry | undefined,
  contextKind: "personal" | "tenant",
  override?: ProviderOverride,
): DataClass | "suspended" | "unknown" {
  if (!entry) return "unknown";
  if (override?.kind === "suspended") return "suspended";
  const base = entry.limits[contextKind];
  return override?.kind === "limit" ? lowerClass(base, override.max) : base;
}
