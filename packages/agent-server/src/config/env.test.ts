import { describe, it, expect, vi, afterEach } from "vitest";
import { loadEnv, retiredEnvWarnings } from "./env.js";

describe("retiredEnvWarnings", () => {
  it("warns for each retired variable that is still set", () => {
    expect(retiredEnvWarnings({ FEATURE_AUTO_EXECUTE: "true", PORT: "4000" })).toEqual([
      "FEATURE_AUTO_EXECUTE is retired; per-action settings now live in Settings → Actions.",
    ]);
    expect(retiredEnvWarnings({})).toEqual([]);
  });
});

describe("model audit key", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("requires MODEL_AUDIT_HMAC_KEY (32+ characters) once any model provider key is set", () => {
    vi.stubEnv("NEXTAUTH_SECRET", "s");
    vi.stubEnv("ALLOWED_EMAILS", "a@test.com");
    vi.stubEnv("API_TOKEN", "t");
    vi.stubEnv("DEEPSEEK_API_KEY", "k");
    vi.stubEnv("LLM_PROVIDER", "deepseek");
    vi.stubEnv("DEEPSEEK_CLASSIFIER_MODEL", "flash");
    vi.stubEnv("DEEPSEEK_SYNTHESIS_MODEL", "pro");
    expect(() => loadEnv()).toThrow(/MODEL_AUDIT_HMAC_KEY/);
    vi.stubEnv("MODEL_AUDIT_HMAC_KEY", "short");
    expect(() => loadEnv()).toThrow(/MODEL_AUDIT_HMAC_KEY/);
    vi.stubEnv("MODEL_AUDIT_HMAC_KEY", "x".repeat(32));
    expect(() => loadEnv()).not.toThrow();
  });
});
