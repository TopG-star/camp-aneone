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

describe("control database and master keys", () => {
  afterEach(() => vi.unstubAllEnvs());

  function baseEnv() {
    vi.stubEnv("NEXTAUTH_SECRET", "s");
    vi.stubEnv("ALLOWED_EMAILS", "a@test.com");
    vi.stubEnv("API_TOKEN", "t");
  }

  it("defaults the control paths and leaves the master keys unset", () => {
    baseEnv();
    const env = loadEnv();
    expect(env.CONTROL_DATABASE_PATH).toBe("./data/control.db");
    expect(env.TENANT_DATA_DIR).toBe("./data/tenants");
    expect(env.ONEON_GRANT_MASTER_KEY).toBeUndefined();
    expect(env.ONEON_SIGNING_KEY_MASTER_KEY).toBeUndefined();
  });

  it("accepts base64 of 32 bytes and rejects anything else", () => {
    baseEnv();
    vi.stubEnv("ONEON_GRANT_MASTER_KEY", Buffer.alloc(32, 1).toString("base64"));
    vi.stubEnv("ONEON_SIGNING_KEY_MASTER_KEY", Buffer.alloc(32, 2).toString("base64"));
    expect(() => loadEnv()).not.toThrow();
    vi.stubEnv("ONEON_GRANT_MASTER_KEY", Buffer.alloc(16, 1).toString("base64"));
    expect(() => loadEnv()).toThrow(/ONEON_GRANT_MASTER_KEY/);
    vi.stubEnv("ONEON_GRANT_MASTER_KEY", Buffer.alloc(32, 1).toString("base64"));
    vi.stubEnv("ONEON_SIGNING_KEY_MASTER_KEY", "not base64!!");
    expect(() => loadEnv()).toThrow(/ONEON_SIGNING_KEY_MASTER_KEY/);
  });
});
