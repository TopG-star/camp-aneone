import { describe, it, expect, vi, afterEach } from "vitest";
import Database from "better-sqlite3";
import { SqliteIdentityRepository, TenantAiLimitRepository, TenantRegistrationRepository, ensureIdentityAnchor, openControlDb, rawDb, runMigrations } from "@oneon/infrastructure";
import type { ContextDb, PersonalDb, TenantDb } from "@oneon/domain";
import { OverrideConfigError, createToolRegistry, createListGitHubPRsTool, type ModelRequest } from "@oneon/application";
import { loadEnv } from "./config/env.js";
import { createModelWiring } from "./model-wiring.js";

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
/** For tests that make no tenant call: no pharmacy is registered. */
const noTenants = { registrations: { findByTenantId: () => null }, tenantLimits: { current: () => "D1" as const } };
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
    expect(createModelWiring(loadEnv(), { context: db(), logger, ...noTenants }).gateway).toBeNull();
  });

  it("routes from the existing LLM variables", () => {
    baseEnv();
    vi.stubEnv("LLM_PROVIDER", "deepseek");
    vi.stubEnv("DEEPSEEK_API_KEY", "k");
    vi.stubEnv("DEEPSEEK_CLASSIFIER_MODEL", "flash");
    vi.stubEnv("DEEPSEEK_SYNTHESIS_MODEL", "pro");
    vi.stubEnv("MODEL_AUDIT_HMAC_KEY", "x".repeat(32));
    const wiring = createModelWiring(loadEnv(), { context: db(), logger, ...noTenants });
    expect(wiring.gateway).not.toBeNull();
    expect(wiring.routing).toEqual({ standard: "deepseek", reasoning: "deepseek" });
    expect(wiring.configuredProviders).toEqual(["deepseek"]);
  });

  it("warns that the standard provider has no key when there is no gateway", () => {
    baseEnv();
    vi.stubEnv("LLM_PROVIDER", "anthropic");
    const wiring = createModelWiring(loadEnv(), { context: db(), logger, ...noTenants });
    expect(wiring.gateway).toBeNull();
    expect(wiring.routingWarnings).toEqual([{ role: "standard", provider: "anthropic" }]);
  });

  it("warns about a routed reasoning or shadow provider without a key", () => {
    deepseekOnly();
    vi.stubEnv("LLM_REASONING_PROVIDER_PREMIUM", "anthropic");
    vi.stubEnv("LLM_SHADOW_PROVIDER", "anthropic");
    const wiring = createModelWiring(loadEnv(), { context: db(), logger, ...noTenants });
    expect(wiring.routingWarnings).toEqual([
      { role: "reasoning", provider: "anthropic" },
      { role: "shadow", provider: "anthropic" },
    ]);
  });

  it("has no warnings when every routed provider has a key", () => {
    deepseekOnly();
    expect(createModelWiring(loadEnv(), { context: db(), logger, ...noTenants }).routingWarnings).toEqual([]);
  });

  it("builds the gateway's authored vocabulary from the real tool registry", () => {
    deepseekOnly();
    const wiring = createModelWiring(loadEnv(), { context: db(), logger, ...noTenants });
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
    expect(() => createModelWiring(loadEnv(), { context: db(), logger, ...noTenants })).toThrow(OverrideConfigError);
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
    const wiring = createModelWiring(loadEnv(), { context: db(), logger, ...noTenants });
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
    const wiring = createModelWiring(loadEnv(), { context: db(), logger, ...noTenants });
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
    expect(createModelWiring(loadEnv(), { context: db(), logger, ...noTenants }).gatewayFor(tenantDb())).toBeNull();
  });

  it("serves the personal handle the personal gateway", () => {
    deepseekOnly();
    const personal = db();
    const wiring = createModelWiring(loadEnv(), { context: personal, logger, ...noTenants });
    expect(wiring.gatewayFor(personal)).toBe(wiring.gateway);
  });

  it("builds one gateway per tenant handle", () => {
    deepseekOnly();
    const wiring = createModelWiring(loadEnv(), { context: db(), logger, ...noTenants });
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
    const wiring = createModelWiring(loadEnv(), { context: personal, logger, ...noTenants });

    const result = await wiring.gatewayFor(handle)!.beginTurn(tenantContext).call(unknownPurpose);

    expect(result).toMatchObject({ kind: "denied" });
    expect(decisionRows(handle)).toEqual([{ tenant_id: "t1", context_kind: "tenant", identity_id: "i1" }]);
    expect(decisionRows(personal)).toEqual([]);
  });

  it("refuses a call whose tenant is not the handle's tenant, and writes nothing", async () => {
    deepseekOnly();
    const personal = db();
    const handle = tenantDb("t1");
    const wiring = createModelWiring(loadEnv(), { context: personal, logger, ...noTenants });

    await expect(wiring.gatewayFor(handle)!.beginTurn({ ...tenantContext, tenantId: "t2" }).call(unknownPurpose)).rejects.toThrow("tenant_mismatch");

    expect(decisionRows(handle)).toEqual([]);
    expect(decisionRows(personal)).toEqual([]);
  });

  it("the personal gateway refuses a tenant context rather than writing it to the personal file", async () => {
    deepseekOnly();
    const personal = db();
    const wiring = createModelWiring(loadEnv(), { context: personal, logger, ...noTenants });

    await expect(wiring.gateway!.beginTurn(tenantContext).call(unknownPurpose)).rejects.toThrow("tenant_mismatch");

    expect(decisionRows(personal)).toEqual([]);
  });
});

describe("createModelWiring tenant limit (spec 9.4)", () => {
  const closers: Array<() => void> = [];
  afterEach(() => {
    for (const close of closers.splice(0)) close();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function setup() {
    baseEnv();
    vi.stubEnv("LLM_PROVIDER", "deepseek");
    vi.stubEnv("DEEPSEEK_API_KEY", "k");
    vi.stubEnv("DEEPSEEK_CLASSIFIER_MODEL", "flash");
    vi.stubEnv("DEEPSEEK_SYNTHESIS_MODEL", "pro");
    vi.stubEnv("MODEL_AUDIT_HMAC_KEY", "x".repeat(32));
    const control = openControlDb(":memory:");
    closers.push(() => control.close());
    const staff = new SqliteIdentityRepository(control).createWithLogin({ kind: "impressorx", subject: "reg-1:staff-1" }).id;
    control
      .prepare(
        "INSERT INTO tenant_registrations (id, tenant_id, tenant_slug, display_name, origin, file_name, status, enrolled_by, enrolled_at) VALUES ('reg-1', 't1', 'acme', 'Acme', 'https://acme.example', 'reg-1.db', 'active', ?, 'now')",
      )
      .run(staff);
    const limits = new TenantAiLimitRepository(control);
    const wiring = createModelWiring(loadEnv(), { context: db(), logger, registrations: new TenantRegistrationRepository(control), tenantLimits: limits });
    const handle: TenantDb = { kind: "tenant", tenantId: "t1", raw: (() => { const d = new Database(":memory:"); runMigrations(d); return d; })(), __brand: "TenantDb" };
    ensureIdentityAnchor(handle, "i1");
    const set = (maxClass: "D0" | "D1" | "D2") => limits.append({ registrationId: "reg-1", maxClass, setBy: staff, liveCheckRef: "test", evidence: null });

    // The provider's HTTP call: what the model would have been sent.
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init: { body: string }) => {
      sent.push(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: "Done.", usedTools: [] }) } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const ask = () =>
      wiring.gatewayFor(handle)!.beginTurn({ kind: "tenant", identityId: "i1", tenantId: "t1", membershipId: "m1" }).call({
        purpose: "chat_reply",
        output: "json",
        parts: [
          { kind: "user_message", text: "show me" },
          { kind: "record", source: "tool:show_my_access", rows: [{ fields: [{ name: "role", class: "D1", value: "Admin" }, { name: "note", class: "D0", value: "public" }] }] },
        ],
      });
    const limitFor = (tenantId: string) => wiring.gateway!.beginTurn({ kind: "tenant", identityId: "i1", tenantId, membershipId: "m1" }).effectiveLimit("chat_reply");
    return { control, set, sent, ask, limitFor };
  }

  it("applies the pharmacy's stored limit to its calls and reads it afresh on every one, so a lowering takes effect at once", async () => {
    const { set, sent, ask } = setup();

    // No row: the default D1 lets a D1 field through.
    expect(await ask()).toMatchObject({ kind: "answered", withheld: [] });
    expect(sent[0]).toContain("Admin");

    // Lowered to D0: the very next call holds the D1 field back. The person's own message is D1 too and a chat reply needs it, so the
    // call is refused and nothing reaches the model.
    set("D0");
    const lowered = await ask();
    expect(lowered).toMatchObject({ kind: "denied", reason: "required_part_withheld" });
    expect(lowered.withheld).toContainEqual(expect.objectContaining({ part: "record:tool:show_my_access", field: "role", reason: "above_limit" }));
    expect(sent).toHaveLength(1);

    // And raised again: the next call goes through.
    set("D1");
    expect(await ask()).toMatchObject({ kind: "answered" });
    expect(sent[1]).toContain("Admin");
  });

  it("is still the lowest of the layers: a stored D2 does not lift the providers' tenant ceiling", () => {
    const { set, limitFor } = setup();
    set("D2");
    expect(limitFor("t1")).toBe("D1");
  });

  it.each([
    ["the registration lookup", { registrations: { findByTenantId: () => { throw new Error("database is locked"); } }, tenantLimits: { current: () => "D2" as const } }],
    ["the stored limit", { registrations: { findByTenantId: () => ({ id: "reg-1" }) as never }, tenantLimits: { current: () => { throw new Error("disk I/O error"); } } }],
  ])("a failure reading %s is logged and fails closed to D0, so the call is still decided and its denial recorded", async (_name, stores) => {
    baseEnv();
    vi.stubEnv("LLM_PROVIDER", "deepseek");
    vi.stubEnv("DEEPSEEK_API_KEY", "k");
    vi.stubEnv("DEEPSEEK_CLASSIFIER_MODEL", "flash");
    vi.stubEnv("DEEPSEEK_SYNTHESIS_MODEL", "pro");
    vi.stubEnv("MODEL_AUDIT_HMAC_KEY", "x".repeat(32));
    const wiring = createModelWiring(loadEnv(), { context: db(), logger, ...stores });
    const handle: TenantDb = { kind: "tenant", tenantId: "t1", raw: (() => { const d = new Database(":memory:"); runMigrations(d); return d; })(), __brand: "TenantDb" };
    ensureIdentityAnchor(handle, "i1");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    logger.warn.mockClear();

    const result = await wiring.gatewayFor(handle)!.beginTurn({ kind: "tenant", identityId: "i1", tenantId: "t1", membershipId: "m1" }).call({
      purpose: "chat_reply",
      output: "json",
      parts: [{ kind: "user_message", text: "show me" }],
    });

    expect(result).toMatchObject({ kind: "denied", reason: "required_part_withheld" }); // D0: even the person's own message is above the limit
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(rawDb(handle).prepare("SELECT tenant_id, decision, effective_limit FROM model_call_decisions").all()).toEqual([
      { tenant_id: "t1", decision: "deny", effective_limit: "D0" },
    ]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("treating the pharmacy as D0"), expect.objectContaining({ tenantId: "t1", error: expect.any(String) }));
  });

  it("a tenant id that matches no active registration is at D0 (fail closed), however the others are set", () => {
    const { set, control, limitFor } = setup();
    set("D1");
    expect(limitFor("t1")).toBe("D1");
    expect(limitFor("someone-else")).toBe("D0");

    control.prepare("UPDATE tenant_registrations SET status = 'disabled_by_tenant' WHERE id = 'reg-1'").run();
    expect(limitFor("t1")).toBe("D0");
  });
});
