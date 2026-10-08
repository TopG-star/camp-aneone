import { describe, it, expect, vi, afterEach } from "vitest";
import Database from "better-sqlite3";
import { ensureIdentityAnchor, rawDb, runMigrations } from "@oneon/infrastructure";
import type { ContextDb, PersonalDb, TenantDb } from "@oneon/domain";
import { OverrideConfigError, createToolRegistry, createListGitHubPRsTool, type ModelRequest } from "@oneon/application";
import { loadEnv } from "./config/env.js";
import { createModelWiring } from "./model-wiring.js";

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
function baseEnv() {
  vi.stubEnv("NEXTAUTH_SECRET", "s");
  vi.stubEnv("ALLOWED_EMAILS", "a@test.com");
  vi.stubEnv("API_TOKEN", "t");
  vi.stubEnv("DATABASE_PATH", ":memory:");
  vi.stubEnv("CONTROL_DATABASE_PATH", ":memory:");
  vi.stubEnv("LOG_LEVEL", "error");
}
function db(): PersonalDb {
  const d = new Database(":memory:");
  runMigrations(d);
  return { kind: "personal", raw: d, __brand: "PersonalDb" };
}

describe("createModelWiring", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("has no gateway when no provider key is configured", () => {
    baseEnv();
    expect(createModelWiring(loadEnv(), { context: db(), logger }).gateway).toBeNull();
  });

  it("routes from the existing LLM variables", () => {
    baseEnv();
    vi.stubEnv("LLM_PROVIDER", "deepseek");
    vi.stubEnv("DEEPSEEK_API_KEY", "k");
    vi.stubEnv("DEEPSEEK_CLASSIFIER_MODEL", "flash");
    vi.stubEnv("DEEPSEEK_SYNTHESIS_MODEL", "pro");
    vi.stubEnv("MODEL_AUDIT_HMAC_KEY", "x".repeat(32));
    const wiring = createModelWiring(loadEnv(), { context: db(), logger });
    expect(wiring.gateway).not.toBeNull();
    expect(wiring.routing).toEqual({ standard: "deepseek", reasoning: "deepseek" });
    expect(wiring.configuredProviders).toEqual(["deepseek"]);
  });

  it("warns that the standard provider has no key when there is no gateway", () => {
    baseEnv();
    vi.stubEnv("LLM_PROVIDER", "anthropic");
    const wiring = createModelWiring(loadEnv(), { context: db(), logger });
    expect(wiring.gateway).toBeNull();
    expect(wiring.routingWarnings).toEqual([{ role: "standard", provider: "anthropic" }]);
  });

  it("warns about a routed reasoning or shadow provider without a key", () => {
    deepseekOnly();
    vi.stubEnv("LLM_REASONING_PROVIDER_PREMIUM", "anthropic");
    vi.stubEnv("LLM_SHADOW_PROVIDER", "anthropic");
    const wiring = createModelWiring(loadEnv(), { context: db(), logger });
    expect(wiring.routingWarnings).toEqual([
      { role: "reasoning", provider: "anthropic" },
      { role: "shadow", provider: "anthropic" },
    ]);
  });

  it("has no warnings when every routed provider has a key", () => {
    deepseekOnly();
    expect(createModelWiring(loadEnv(), { context: db(), logger }).routingWarnings).toEqual([]);
  });

  it("builds the gateway's authored vocabulary from the real tool registry", () => {
    deepseekOnly();
    const wiring = createModelWiring(loadEnv(), { context: db(), logger });
    expect(wiring.toolVocabulary()).toBe("");
    const registry = createToolRegistry();
    registry.register(createListGitHubPRsTool({}));
    wiring.setToolVocabulary(registry.list());
    expect(wiring.toolVocabulary()).toContain("list_github_prs: List GitHub pull requests.");
  });

  it("refuses to start on a bad override", () => {
    baseEnv();
    vi.stubEnv("DEEPSEEK_API_KEY", "k");
    vi.stubEnv("LLM_PROVIDER", "deepseek");
    vi.stubEnv("DEEPSEEK_CLASSIFIER_MODEL", "flash");
    vi.stubEnv("DEEPSEEK_SYNTHESIS_MODEL", "pro");
    vi.stubEnv("MODEL_AUDIT_HMAC_KEY", "x".repeat(32));
    vi.stubEnv("MODEL_PROVIDER_OVERRIDES", "deepsek:suspended");
    expect(() => createModelWiring(loadEnv(), { context: db(), logger })).toThrow(OverrideConfigError);
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
    const wiring = createModelWiring(loadEnv(), { context: db(), logger });
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
    const wiring = createModelWiring(loadEnv(), { context: db(), logger });
    expect(wiring.gateway).not.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      "Model gateway: routed provider has no key; its calls will be denied",
      { role: "shadow", provider: "anthropic" },
    );
  });
});

describe("createModelWiring gatewayFor", () => {
  afterEach(() => vi.unstubAllEnvs());

  function deepseekOnly() {
    baseEnv();
    vi.stubEnv("LLM_PROVIDER", "deepseek");
    vi.stubEnv("DEEPSEEK_API_KEY", "k");
    vi.stubEnv("DEEPSEEK_CLASSIFIER_MODEL", "flash");
    vi.stubEnv("DEEPSEEK_SYNTHESIS_MODEL", "pro");
    vi.stubEnv("MODEL_AUDIT_HMAC_KEY", "x".repeat(32));
  }
  function tenantDb(tenantId = "t1"): TenantDb {
    const d = new Database(":memory:");
    runMigrations(d);
    return { kind: "tenant", tenantId, raw: d, __brand: "TenantDb" };
  }
  const tenantContext = { kind: "tenant", identityId: "i1", tenantId: "t1", membershipId: "m1" } as const;
  // An unknown purpose is denied before any provider is called, and the denial is still audited.
  const unknownPurpose: ModelRequest = { purpose: "no_such_purpose", output: "json", parts: [{ kind: "user_message", text: "hi" }] };
  const decisionRows = (handle: ContextDb) => rawDb(handle).prepare("SELECT tenant_id, context_kind, identity_id FROM model_call_decisions").all();

  it("has no gateway for any handle when no provider key is configured", () => {
    baseEnv();
    expect(createModelWiring(loadEnv(), { context: db(), logger }).gatewayFor(tenantDb())).toBeNull();
  });

  it("serves the personal handle the personal gateway", () => {
    deepseekOnly();
    const personal = db();
    const wiring = createModelWiring(loadEnv(), { context: personal, logger });
    expect(wiring.gatewayFor(personal)).toBe(wiring.gateway);
  });

  it("builds one gateway per tenant handle", () => {
    deepseekOnly();
    const wiring = createModelWiring(loadEnv(), { context: db(), logger });
    const handle = tenantDb();
    expect(wiring.gatewayFor(handle)).toBe(wiring.gatewayFor(handle));
    expect(wiring.gatewayFor(handle)).not.toBe(wiring.gateway);
    expect(wiring.gatewayFor(tenantDb())).not.toBe(wiring.gatewayFor(handle));
  });

  it("writes a tenant call's audit row to that handle's file, not the personal one", async () => {
    deepseekOnly();
    const personal = db();
    const handle = tenantDb();
    ensureIdentityAnchor(handle, "i1");
    const wiring = createModelWiring(loadEnv(), { context: personal, logger });

    const result = await wiring.gatewayFor(handle)!.beginTurn(tenantContext).call(unknownPurpose);

    expect(result).toMatchObject({ kind: "denied" });
    expect(decisionRows(handle)).toEqual([{ tenant_id: "t1", context_kind: "tenant", identity_id: "i1" }]);
    expect(decisionRows(personal)).toEqual([]);
  });

  it("refuses a call whose tenant is not the handle's tenant, and writes nothing", async () => {
    deepseekOnly();
    const personal = db();
    const handle = tenantDb("t1");
    const wiring = createModelWiring(loadEnv(), { context: personal, logger });

    await expect(wiring.gatewayFor(handle)!.beginTurn({ ...tenantContext, tenantId: "t2" }).call(unknownPurpose)).rejects.toThrow("tenant_mismatch");

    expect(decisionRows(handle)).toEqual([]);
    expect(decisionRows(personal)).toEqual([]);
  });

  it("the personal gateway refuses a tenant context rather than writing it to the personal file", async () => {
    deepseekOnly();
    const personal = db();
    const wiring = createModelWiring(loadEnv(), { context: personal, logger });

    await expect(wiring.gateway!.beginTurn(tenantContext).call(unknownPurpose)).rejects.toThrow("tenant_mismatch");

    expect(decisionRows(personal)).toEqual([]);
  });
});
