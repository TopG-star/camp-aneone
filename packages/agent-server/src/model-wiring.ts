import type Database from "better-sqlite3";
import type { Logger } from "@oneon/domain";
import {
  createModelGateway,
  Fingerprinter,
  parseProviderOverrides,
  type AiDataChoiceRepository,
  type ModelAuditRepository,
  type ModelGateway,
  type ModelProvider,
  type ModelRouting,
  type ProviderId,
} from "@oneon/application";
import { AnthropicProvider, DeepSeekProvider, SqliteAiDataChoiceRepository, SqliteModelAuditRepository } from "@oneon/infrastructure";
import type { Env } from "./config/env.js";

/** The only place provider clients are constructed (architecture test, Task 16). */
/** The vocabulary the gateway exempts from its restored-value checks: every registered tool's name and description. */
export const toolVocabulary = (tools: Array<{ name: string; description: string }>): string => tools.map((t) => `${t.name}: ${t.description}`).join("\n");

export function createModelWiring(env: Env, deps: { db: Database.Database; logger: Logger }) {
  const choices: AiDataChoiceRepository = new SqliteAiDataChoiceRepository(deps.db);
  const audit: ModelAuditRepository = new SqliteModelAuditRepository(deps.db);
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
  if (!providers[standard]) {
    deps.logger.warn("Model gateway: disabled (no key for LLM_PROVIDER)", { provider: standard });
    return { gateway: null as ModelGateway | null, routing: null as ModelRouting | null, choices, audit, configuredProviders, overrides, setToolVocabulary, toolVocabulary: currentToolVocabulary };
  }
  const routing: ModelRouting = {
    standard,
    reasoning: env.LLM_REASONING_PROVIDER_PREMIUM !== "none" ? (env.LLM_REASONING_PROVIDER_PREMIUM as ProviderId) : standard,
    ...(env.LLM_SHADOW_PROVIDER !== "none" ? { shadow: env.LLM_SHADOW_PROVIDER as ProviderId } : {}),
  };
  const missing: Array<{ role: "reasoning" | "shadow"; provider: ProviderId }> = [];
  if (!providers[routing.reasoning]) missing.push({ role: "reasoning", provider: routing.reasoning });
  if (routing.shadow && !providers[routing.shadow]) missing.push({ role: "shadow", provider: routing.shadow });
  for (const m of missing) deps.logger.warn("Model gateway: routed provider has no key; its calls will be denied", m);

  const deepseekModels =
    env.DEEPSEEK_API_KEY && env.DEEPSEEK_CLASSIFIER_MODEL && env.DEEPSEEK_SYNTHESIS_MODEL
      ? { standard: env.DEEPSEEK_CLASSIFIER_MODEL, reasoning: env.DEEPSEEK_SYNTHESIS_MODEL }
      : undefined;
  const gateway = createModelGateway({
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
  });
  deps.logger.info(missing.length ? "Model gateway: active (degraded routing)" : "Model gateway: ✓ active", { routing, overrides: Object.fromEntries(overrides) });
  return { gateway, routing, choices, audit, configuredProviders, overrides, setToolVocabulary, toolVocabulary: currentToolVocabulary };
}
