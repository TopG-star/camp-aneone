import { describe, it, expect } from "vitest";
import { retiredEnvWarnings } from "./env.js";

describe("retiredEnvWarnings", () => {
  it("warns for each retired variable that is still set", () => {
    expect(retiredEnvWarnings({ FEATURE_AUTO_EXECUTE: "true", PORT: "4000" })).toEqual([
      "FEATURE_AUTO_EXECUTE is retired; per-action settings now live in Settings → Actions.",
    ]);
    expect(retiredEnvWarnings({})).toEqual([]);
  });
});
