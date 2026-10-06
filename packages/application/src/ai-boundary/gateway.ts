import { randomUUID } from "node:crypto";
import type { Logger } from "@oneon/domain";
import { ApprovedModelCall, ProviderError, type ModelProvider } from "./approved-call.js";
import { checkAnswer, restoreToolParams, type OutputBlockReason } from "./answer-check.js";
import { assemblePrompt } from "./assemble.js";
import type { AiDataChoiceRepository, ModelAuditRepository } from "./audit.js";
import { decide, type Decision, type DenyReason, type FieldDisposition, type WithheldItem } from "./decide.js";
import type { Fingerprinter } from "./fingerprints.js";
import { PlaceholderMap } from "./placeholders.js";
import { findRestoredValue } from "./restored-values.js";
import { PROVIDER_REGISTRY, providerLimit, type ProviderEntry, type ProviderOverride } from "./providers.js";
import { PURPOSES, type PurposeDefinition } from "./purposes/index.js";
import { removeSpans } from "./scanner.js";
import { classRank, lowerClass, type ClassifiedField, type DataClass, type ModelContext, type ModelRequest, type ProviderId } from "./types.js";

export const TENANT_CHOICE_LIMIT: DataClass = "D1";

export type GatewayResult =
  | { kind: "answered"; text: string; json?: unknown; withheld: WithheldItem[]; decisionId: string }
  | { kind: "denied"; reason: DenyReason; withheld: WithheldItem[]; decisionId: string }
  | { kind: "blocked"; reason: OutputBlockReason; withheld: WithheldItem[]; decisionId: string }
  | { kind: "failed"; message: string; withheld: WithheldItem[]; decisionId: string };

export interface ModelRouting {
  standard: ProviderId;
  reasoning: ProviderId;
  shadow?: ProviderId;
}

export interface ModelGatewayDeps {
  providers: Partial<Record<ProviderId, ModelProvider>>;
  registry?: Record<ProviderId, ProviderEntry>;
  overrides: Map<ProviderId, ProviderOverride>;
  routing: ModelRouting;
  models: Partial<Record<ProviderId, { standard: string; reasoning: string }>>;
  choices: AiDataChoiceRepository;
  audit: ModelAuditRepository;
  fingerprinter: Fingerprinter;
  maxRetries: number;
  timeouts: { standard: number; reasoning: number };
  logger: Logger;
  clock?: () => Date;
  newId?: () => string;
  purposes?: Record<string, PurposeDefinition>;
  /** The registered tools' names and descriptions, read on each call (the tool registry is built after the gateway). Exempts Oneon's own words from the restored-value checks. */
  authoredVocabulary?: () => string;
}

export interface ModelTurn {
  call(request: ModelRequest): Promise<GatewayResult>;
  restoreToolParams(params: Record<string, unknown>): ReturnType<typeof restoreToolParams>;
  effectiveLimit(purpose: string): DataClass | null;
}

export interface ModelGateway {
  beginTurn(context: ModelContext, options?: { channel?: string }): ModelTurn;
}

/** The text the person wrote that was actually sent in this request, with D3 spans removed (answer check O1 exemption). */
function sentUserText(request: ModelRequest, decision: Extract<Decision, { kind: "allow" }>): string {
  const texts: string[] = [];
  request.parts.forEach((part, i) => {
    const outcome = decision.parts[i];
    if (part.kind === "user_message" && outcome?.disposition?.kind === "sent") {
      texts.push(removeSpans(part.text, outcome.disposition.d3Spans ?? []));
    } else if (part.kind === "history") {
      part.turns.forEach((turn, t) => {
        const d = outcome?.turns?.[t];
        if (turn.role === "user" && d?.kind === "sent") texts.push(removeSpans(turn.text, d.d3Spans ?? []));
      });
    }
  });
  return texts.join("\n");
}

/** Strings of a sent field, as the prompt shows them (D3 spans removed). A placeholder carries no value. */
function sentFieldText(f: ClassifiedField, d: FieldDisposition): string | null {
  if (d.kind === "sent") return typeof f.value === "string" ? removeSpans(f.value, d.d3Spans ?? []) : JSON.stringify(f.value) ?? "null";
  if (d.kind === "aggregate") return typeof f.value === "string" ? f.value : JSON.stringify(f.value) ?? "null";
  return null;
}

/**
 * The data in this request that could carry a restored value, as actually sent: sent and aggregate record field values
 * (the persona record excepted) and sent history turns. Not instructions, the tool catalog, record headers or field names.
 */
function sentDataText(request: ModelRequest, decision: Extract<Decision, { kind: "allow" }>): string {
  const texts: string[] = [];
  request.parts.forEach((part, p) => {
    const outcome = decision.parts[p];
    if (outcome?.disposition?.kind === "withheld") return;
    if (part.kind === "history") {
      part.turns.forEach((turn, t) => {
        const d = outcome?.turns?.[t];
        if (d?.kind === "sent") texts.push(removeSpans(turn.text, d.d3Spans ?? []));
      });
    } else if (part.kind === "record" && part.source !== "persona") {
      part.rows.forEach((r, ri) => {
        const rowOutcome = outcome?.rows?.[ri];
        if (!rowOutcome || rowOutcome.withheld) return;
        r.fields.forEach((f, fi) => {
          const text = sentFieldText(f, rowOutcome.fields[fi]);
          if (text !== null) texts.push(text);
        });
      });
    }
  });
  return texts.join("\n");
}

/**
 * Oneon's code-authored vocabulary, whatever this call sent: the registered tools' names and descriptions (`vocabulary`),
 * every purpose's instructions, this request's instruction parts, tool catalog, record source names, and persona values.
 * A non-address form that also appears here is Oneon's own word, not a restored value.
 */
function authoredText(request: ModelRequest, purposes: Record<string, PurposeDefinition>, vocabulary: string): string {
  const texts: string[] = [vocabulary, ...Object.values(purposes).map((p) => p.instructions)];
  for (const part of request.parts) {
    if (part.kind === "instruction") texts.push(part.text);
    else if (part.kind === "tool_catalog") for (const t of part.tools) texts.push(t.name, t.description);
    else if (part.kind === "record") {
      texts.push(part.source);
      if (part.source === "persona") for (const r of part.rows) for (const f of r.fields) if (typeof f.value === "string") texts.push(f.value);
    }
  }
  return texts.join("\n");
}

export function createModelGateway(deps: ModelGatewayDeps): ModelGateway {
  const registry = deps.registry ?? PROVIDER_REGISTRY;
  const purposes: Record<string, PurposeDefinition> = deps.purposes ?? PURPOSES;
  const purposeOf = (name: string): PurposeDefinition | undefined => (Object.prototype.hasOwnProperty.call(purposes, name) ? purposes[name] : undefined);
  const clock = deps.clock ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;

  const choiceLimit = (context: ModelContext, provider: ProviderId): DataClass =>
    context.kind === "tenant" ? TENANT_CHOICE_LIMIT : (deps.choices.current(context.identityId, provider)?.maxClass ?? "D1");

  const providerFor = (purpose: string): ProviderId => {
    return purposeOf(purpose)?.tier === "reasoning" ? deps.routing.reasoning : deps.routing.standard;
  };

  async function runCall(
    context: ModelContext,
    channel: string | null,
    request: ModelRequest,
    provider: ProviderId,
    map: PlaceholderMap,
  ): Promise<GatewayResult> {
    const callId = newId();
    const decisionId = newId();
    const def = purposeOf(request.purpose);
    const entry = deps.providers[provider] ? registry[provider] : undefined;
    const decision = decide({ context, request, provider: { entry, override: deps.overrides.get(provider) }, choiceLimit: choiceLimit(context, provider), purposes });
    const tier = def?.tier ?? "standard";
    const model = deps.models[provider]?.[tier] ?? null;
    const base = {
      id: decisionId,
      callId,
      createdAt: clock().toISOString(),
      contextKind: context.kind,
      identityId: context.identityId,
      tenantId: context.kind === "tenant" ? context.tenantId : null,
      membershipId: context.kind === "tenant" ? context.membershipId : null,
      purpose: request.purpose,
      channel,
      provider,
      model,
      effectiveLimit: decision.effectiveLimit,
      layers: decision.layers,
      withheld: decision.withheld,
      scannerHits: decision.scannerHits,
      alert: decision.alert,
      policyFingerprint: deps.fingerprinter.policy(context, { layers: decision.layers, purpose: request.purpose, provider }),
      keyVersion: deps.fingerprinter.keyVersion,
    };
    if (decision.alert) deps.logger.warn("boundary_alert", { purpose: request.purpose, callId, withheld: decision.withheld.length });

    if (decision.kind === "deny") {
      deps.audit.recordDecision({ ...base, decision: "deny", denyReason: decision.reason, released: [], placeholderCount: 0, inputFingerprint: null });
      return { kind: "denied", reason: decision.reason, withheld: decision.withheld, decisionId };
    }

    // decide() denies unknown purposes, so an allow always has a definition.
    const definition = def!;
    const assembled = assemblePrompt(request, decision, definition, map);
    const userText = sentUserText(request, decision);
    const authored = authoredText(request, purposes, deps.authoredVocabulary?.() ?? "");

    // Input check (final review C1): below D2, a value this turn replaced with a placeholder must not reach the
    // prompt another way, e.g. echoed by a tool after its placeholder was restored. Values the person typed are exempt.
    if (classRank(decision.effectiveLimit) < classRank("D2") && findRestoredValue(sentDataText(request, decision), map, userText, authored)) {
      deps.logger.warn("boundary_alert", { purpose: request.purpose, callId, reason: "masked_value_present" });
      deps.audit.recordDecision({ ...base, alert: true, decision: "deny", denyReason: "masked_value_present", released: [], placeholderCount: 0, inputFingerprint: null });
      return { kind: "denied", reason: "masked_value_present", withheld: decision.withheld, decisionId };
    }

    deps.audit.recordDecision({
      ...base,
      decision: "allow",
      denyReason: null,
      released: assembled.released,
      placeholderCount: assembled.placeholderCount,
      inputFingerprint: deps.fingerprinter.of(context, `${assembled.system}\n\n${assembled.user}`),
    });

    const approved = ApprovedModelCall.mint({
      callId,
      provider,
      model: model ?? "",
      system: assembled.system,
      user: assembled.user,
      json: request.output === "json",
      maxTokens: definition.maxTokens,
      timeoutMs: deps.timeouts[tier],
    });

    const started = clock().getTime();
    let attempts = 0;
    let last: ReturnType<typeof checkAnswer> | null = null;
    let failure: string | null = null;
    let tokens: { input: number | null; output: number | null } = { input: null, output: null };
    while (attempts <= deps.maxRetries) {
      attempts++;
      try {
        const completion = await deps.providers[provider]!.complete(approved);
        tokens = { input: completion.inputTokens ?? null, output: completion.outputTokens ?? null };
        last = checkAnswer({ raw: completion.text, output: request.output, schema: definition.outputSchema, map, restoreNames: definition.restoreNames, userText, authoredText: authored });
        failure = null;
        if (last.ok || last.reason !== "invalid_output") break;
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        last = null;
        if (!(error instanceof ProviderError && error.retryable)) break;
      }
    }

    const outcomeBase = {
      callId,
      createdAt: clock().toISOString(),
      attempts,
      latencyMs: clock().getTime() - started,
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      keyVersion: deps.fingerprinter.keyVersion,
    };
    if (failure !== null || last === null) {
      deps.audit.recordOutcome({ ...outcomeBase, status: "failed", blockReason: null, checks: { O1: "skipped", O2: "skipped", O3: "skipped", O4: "skipped" }, outputFingerprint: null });
      return { kind: "failed", message: failure ?? "no answer", withheld: decision.withheld, decisionId };
    }
    if (!last.ok) {
      deps.audit.recordOutcome({ ...outcomeBase, status: "blocked", blockReason: last.reason, checks: last.checks, outputFingerprint: null });
      return { kind: "blocked", reason: last.reason, withheld: decision.withheld, decisionId };
    }
    deps.audit.recordOutcome({ ...outcomeBase, status: "answered", blockReason: null, checks: last.checks, outputFingerprint: deps.fingerprinter.of(context, last.text) });
    return { kind: "answered", text: last.text, json: last.json, withheld: decision.withheld, decisionId };
  }

  return {
    beginTurn(context, options) {
      const map = new PlaceholderMap();
      // Spec §6.8: the shadow provider may have a lower limit, so its placeholders live in a map of their own.
      const shadowMap = new PlaceholderMap();
      const channel = options?.channel ?? null;
      return {
        async call(request) {
          const provider = providerFor(request.purpose);
          const result = await runCall(context, channel, request, provider, map);
          const shadow = deps.routing.shadow;
          if (shadow && shadow !== provider && deps.providers[shadow]) {
            // Spec §6.8: the shadow copy is its own call with its own decision; it never affects the result.
            void runCall(context, "shadow", request, shadow, shadowMap).catch((error: unknown) =>
              deps.logger.warn("Shadow model call failed", { error: error instanceof Error ? error.message : String(error) }),
            );
          }
          return result;
        },
        restoreToolParams: (params) => restoreToolParams(params, map),
        effectiveLimit(purpose) {
          const def = purposeOf(purpose);
          if (!def) return null;
          const provider = providerFor(purpose);
          const p = providerLimit(deps.providers[provider] ? registry[provider] : undefined, context.kind, deps.overrides.get(provider));
          if (p === "suspended" || p === "unknown") return null;
          return lowerClass(lowerClass(p, choiceLimit(context, provider)), def.limit);
        },
      };
    },
  };
}
