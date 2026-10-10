import { contextRepos } from "./context-wiring.js";
import type { ContextDb, Logger } from "@oneon/domain";
import {
  createModelGateway,
  Fingerprinter,
  parseProviderOverrides,
  type AiDataChoiceRepository,
  type ModelAuditRepository,
  type ModelGateway,
  type ModelGatewayDeps,
  type ModelProvider,
  type ModelRouting,
  type ProviderId,
} from "@oneon/application";
import {
  AnthropicProvider,
  DeepSeekProvider,
  SqliteAiDataChoiceRepository,
  rawDb,
  type TenantAiLimitRepository,
  type TenantRegistrationRepository,
} from "@oneon/infrastructure";
import type { Env } from "./config/env.js";

/** The only place provider clients are constructed (architecture test, Task 16). */
/** The vocabulary the gateway exempts from its restored-value checks: every registered tool's name and description. */
export const toolVocabulary = (tools: Array<{ name: string; description: string }>): string => tools.map((t) => `${t.name}: ${t.description}`).join("\n");

export function createModelWiring(
  env: Env,
  deps: {
    context: ContextDb;
    logger: Logger;
    /** Finds the registration whose rows carry a model context's tenant id. */
    registrations: Pick<TenantRegistrationRepository, "findByTenantId">;
    /** The stored pharmacy limits (spec 9.4), read on every call. */
    tenantLimits: Pick<TenantAiLimitRepository, "current">;
  },
) {
  const choices: AiDataChoiceRepository = new SqliteAiDataChoiceRepository(rawDb(deps.context));
  const audit: ModelAuditRepository = contextRepos(deps.context).modelAudit;
  const breaker = { failureThreshold: env.CB_FAILURE_THRESHOLD, resetTimeoutMs: env.CB_RESET_TIMEOUT_MS };
  const providers: Partial<Record<ProviderId, ModelProvider>> = {};
  if (env.DEEPSEEK_API_KEY) providers.deepseek = new DeepSeekProvider({ apiKey: env.DEEPSEEK_API_KEY, circuitBreaker: breaker, logger: deps.logger });
  if (env.ANTHROPIC_API_KEY) providers.anthropic = new AnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY, circuitBreaker: breaker, logger: deps.logger });
  const configuredProviders = Object.keys(providers) as ProviderId[];
  // The tool registry is built after the container, so the routes hand its tools over once it is complete.
  let vocabulary = "";
  const setToolVocabulary = (tools: Array<{ name: string; description: string }>): void => {
    vocabulary = toolVocabulary(tools);
  };
  const currentToolVocabulary = (): string => vocabulary;

  const overrides = parseProviderOverrides(env.MODEL_PROVIDER_OVERRIDES); // throws: the server refuses to start (spec §6.7)
  const standard = env.LLM_PROVIDER as ProviderId;
  const routingWarnings: Array<{ role: "standard" | "reasoning" | "shadow"; provider: ProviderId }> = [];
  if (!providers[standard]) {
    routingWarnings.push({ role: "standard", provider: standard });
    deps.logger.warn("Model gateway: disabled (no key for LLM_PROVIDER)", { provider: standard });
    return { gateway: null as ModelGateway | null, gatewayFor: (_db: ContextDb): ModelGateway | null => null, routing: null as ModelRouting | null, choices, audit, configuredProviders, routingWarnings, overrides, setToolVocabulary, toolVocabulary: currentToolVocabulary };
  }
  const routing: ModelRouting = {
    standard,
    reasoning: env.LLM_REASONING_PROVIDER_PREMIUM !== "none" ? (env.LLM_REASONING_PROVIDER_PREMIUM as ProviderId) : standard,
    ...(env.LLM_SHADOW_PROVIDER !== "none" ? { shadow: env.LLM_SHADOW_PROVIDER as ProviderId } : {}),
  };
  if (!providers[routing.reasoning]) routingWarnings.push({ role: "reasoning", provider: routing.reasoning });
  if (routing.shadow && !providers[routing.shadow]) routingWarnings.push({ role: "shadow", provider: routing.shadow });
  for (const m of routingWarnings) deps.logger.warn("Model gateway: routed provider has no key; its calls will be denied", m);

  const deepseekModels =
    env.DEEPSEEK_API_KEY && env.DEEPSEEK_CLASSIFIER_MODEL && env.DEEPSEEK_SYNTHESIS_MODEL
      ? { standard: env.DEEPSEEK_CLASSIFIER_MODEL, reasoning: env.DEEPSEEK_SYNTHESIS_MODEL }
      : undefined;
  const gatewayDeps: ModelGatewayDeps = {
    providers,
    overrides,
    routing,
    models: {
      ...(deepseekModels ? { deepseek: deepseekModels } : {}),
      ...(env.ANTHROPIC_API_KEY ? { anthropic: { standard: env.LLM_CLASSIFIER_MODEL, reasoning: env.LLM_SYNTHESIS_MODEL } } : {}),
    },
    choices,
    audit,
    fingerprinter: new Fingerprinter(env.MODEL_AUDIT_HMAC_KEY!, env.MODEL_AUDIT_HMAC_KEY_VERSION),
    maxRetries: env.LLM_MAX_RETRIES,
    timeouts: { standard: env.LLM_CLASSIFIER_TIMEOUT_MS, reasoning: env.LLM_SYNTHESIS_TIMEOUT_MS },
    logger: deps.logger,
    authoredVocabulary: currentToolVocabulary,
    // The pharmacy's stored limit (spec 9.4), read afresh on every call so a lowering takes effect at once. A tenant id that matches no
    // active registration is nobody Oneon can vouch for: D0. So is one whose limit cannot be read: the failure is logged, and the call is
    // still decided (and its decision recorded) at D0 rather than thrown out of the gateway.
    tenantLimit: (tenantId) => {
      try {
        const registration = deps.registrations.findByTenantId(tenantId);
        return registration ? deps.tenantLimits.current(registration.id) : "D0";
      } catch (error) {
        deps.logger.warn("Tenant AI limit could not be read; treating the pharmacy as D0", { tenantId, error: error instanceof Error ? error.message : String(error) });
        return "D0";
      }
    },
  };
  const gateway = createModelGateway(gatewayDeps);
  // A tenant request gets a gateway whose audit is that request's own handle: its decision and outcome rows are written to
  // the tenant file, and the repository refuses (tenant_mismatch) a context that names another tenant. Built once per handle.
  const tenantGateways = new WeakMap<ContextDb, ModelGateway>();
  const gatewayFor = (db: ContextDb): ModelGateway | null => {
    if (db === deps.context) return gateway;
    let tenantGateway = tenantGateways.get(db);
    if (!tenantGateway) {
      tenantGateway = createModelGateway({ ...gatewayDeps, auditFor: () => contextRepos(db).modelAudit });
      tenantGateways.set(db, tenantGateway);
    }
    return tenantGateway;
  };
  deps.logger.info(routingWarnings.length ? "Model gateway: active (degraded routing)" : "Model gateway: ✓ active", { routing, overrides: Object.fromEntries(overrides) });
  return { gateway, gatewayFor, routing, choices, audit, configuredProviders, routingWarnings, overrides, setToolVocabulary, toolVocabulary: currentToolVocabulary };
}
