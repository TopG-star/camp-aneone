import { describe, it, expect, vi, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@oneon/infrastructure";
import { OverrideConfigError } from "@oneon/application";
import { loadEnv } from "./config/env.js";
import { createModelWiring } from "./model-wiring.js";

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
function baseEnv() {
  vi.stubEnv("NEXTAUTH_SECRET", "s");
  vi.stubEnv("ALLOWED_EMAILS", "a@test.com");
  vi.stubEnv("API_TOKEN", "t");
  vi.stubEnv("DATABASE_PATH", ":memory:");
  vi.stubEnv("LOG_LEVEL", "error");
}
function db() {
  const d = new Database(":memory:");
  runMigrations(d);
  return d;
}

describe("createModelWiring", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("has no gateway when no provider key is configured", () => {
    baseEnv();
    expect(createModelWiring(loadEnv(), { db: db(), logger }).gateway).toBeNull();
  });

  it("routes from the existing LLM variables", () => {
    baseEnv();
    vi.stubEnv("LLM_PROVIDER", "deepseek");
    vi.stubEnv("DEEPSEEK_API_KEY", "k");
    vi.stubEnv("DEEPSEEK_CLASSIFIER_MODEL", "flash");
    vi.stubEnv("DEEPSEEK_SYNTHESIS_MODEL", "pro");
    vi.stubEnv("MODEL_AUDIT_HMAC_KEY", "x".repeat(32));
    const wiring = createModelWiring(loadEnv(), { db: db(), logger });
    expect(wiring.gateway).not.toBeNull();
    expect(wiring.routing).toEqual({ standard: "deepseek", reasoning: "deepseek" });
    expect(wiring.configuredProviders).toEqual(["deepseek"]);
  });

  it("refuses to start on a bad override", () => {
    baseEnv();
    vi.stubEnv("DEEPSEEK_API_KEY", "k");
    vi.stubEnv("LLM_PROVIDER", "deepseek");
    vi.stubEnv("DEEPSEEK_CLASSIFIER_MODEL", "flash");
    vi.stubEnv("DEEPSEEK_SYNTHESIS_MODEL", "pro");
    vi.stubEnv("MODEL_AUDIT_HMAC_KEY", "x".repeat(32));
    vi.stubEnv("MODEL_PROVIDER_OVERRIDES", "deepsek:suspended");
    expect(() => createModelWiring(loadEnv(), { db: db(), logger })).toThrow(OverrideConfigError);
  });

  function deepseekOnly() {
    baseEnv();
    vi.stubEnv("LLM_PROVIDER", "deepseek");
    vi.stubEnv("DEEPSEEK_API_KEY", "k");
    vi.stubEnv("DEEPSEEK_CLASSIFIER_MODEL", "flash");
    vi.stubEnv("DEEPSEEK_SYNTHESIS_MODEL", "pro");
    vi.stubEnv("MODEL_AUDIT_HMAC_KEY", "x".repeat(32));
  }

  it("warns when the reasoning provider has no key but still builds the gateway", () => {
    deepseekOnly();
    vi.stubEnv("LLM_REASONING_PROVIDER_PREMIUM", "anthropic");
    logger.warn.mockClear();
    const wiring = createModelWiring(loadEnv(), { db: db(), logger });
    expect(wiring.gateway).not.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      "Model gateway: routed provider has no key; its calls will be denied",
      { role: "reasoning", provider: "anthropic" },
    );
  });

  it("warns when the shadow provider has no key but still builds the gateway", () => {
    deepseekOnly();
    vi.stubEnv("LLM_SHADOW_PROVIDER", "anthropic");
    logger.warn.mockClear();
    const wiring = createModelWiring(loadEnv(), { db: db(), logger });
    expect(wiring.gateway).not.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      "Model gateway: routed provider has no key; its calls will be denied",
      { role: "shadow", provider: "anthropic" },
    );
  });
});
