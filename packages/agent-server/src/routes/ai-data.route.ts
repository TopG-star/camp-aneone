import { Router } from "express";
import { AiDataChoiceWriteSchema, type AiDataView } from "@oneon/contracts";
import type { Logger } from "@oneon/domain";
import {
  PROVIDER_REGISTRY,
  PROVIDER_IDS,
  RECORDED_DECISIONS,
  classRank,
  type AiDataChoiceRepository,
  type ModelAuditRepository,
  type ModelGateway,
  type ModelRouting,
  type ProviderId,
  type ProviderOverride,
} from "@oneon/application";

export interface AiDataRouteDeps {
  gateway: ModelGateway | null;
  routing: ModelRouting | null;
  overrides: Map<ProviderId, ProviderOverride>;
  configuredProviders: ProviderId[];
  choices: AiDataChoiceRepository;
  audit: ModelAuditRepository;
  clock?: () => Date;
  logger: Logger;
}

export function createAiDataRouter(deps: AiDataRouteDeps): Router {
  const router = Router();
  const clock = deps.clock ?? (() => new Date());

  const view = (userId: string): AiDataView => {
    const providers = PROVIDER_IDS.map((id) => {
      const entry = PROVIDER_REGISTRY[id];
      const choice = deps.choices.current(userId, id);
      const override = deps.overrides.get(id);
      return {
        id,
        label: entry.label,
        review: entry.review,
        limits: entry.limits,
        override: override ? (override.kind === "suspended" ? "suspended" : override.max) : null,
        configured: deps.configuredProviders.includes(id),
        personalChoice: choice?.maxClass ?? ("D1" as const),
        choiceConfirmedAt: choice?.confirmedAt ?? null,
      };
    });
    const pending = RECORDED_DECISIONS.find((d) => deps.choices.current(userId, d.provider) === null) ?? null;
    const limit = deps.gateway?.beginTurn({ kind: "personal", identityId: userId }).effectiveLimit("email_classification") ?? null;
    const standardLabel = deps.routing ? PROVIDER_REGISTRY[deps.routing.standard].label : "";
    const active = limit !== null && classRank(limit) >= classRank("D2");
    const standardUnavailable =
      deps.routing !== null && (deps.overrides.get(deps.routing.standard)?.kind === "suspended" || !deps.configuredProviders.includes(deps.routing.standard));
    const standardOverride = deps.routing ? deps.overrides.get(deps.routing.standard) : undefined;
    const standardCapped = standardOverride?.kind === "limit" && classRank(standardOverride.max) < classRank("D2");
    const reason = !deps.gateway
      ? "No AI provider is configured."
      : active
        ? null
        : standardUnavailable
          ? `Email classification is paused: ${standardLabel} is currently unavailable.`
          : standardCapped
            ? `Email classification is paused: the platform currently limits what can be sent to ${standardLabel}.`
            : `Email classification needs your approval to send email content (D2) to ${standardLabel}. Choose D2 for ${standardLabel} in Settings → AI data to resume.`;
    const recent = deps.audit.listRecentForIdentity(userId, 20).map(({ decision, outcome }) => ({
      callId: decision.callId,
      at: decision.createdAt,
      purpose: decision.purpose,
      channel: decision.channel,
      provider: decision.provider,
      decision: decision.decision,
      effectiveLimit: decision.effectiveLimit,
      denyReason: decision.denyReason,
      withheldCount: decision.withheld.length,
      alert: decision.alert,
      outcome: outcome?.status ?? null,
    }));
    return { providers, pendingDecision: pending, emailClassification: { active, reason }, recent };
  };

  router.get("/", (req, res) => {
    try {
      res.json(view(req.userId!));
    } catch (error) {
      deps.logger.error("Failed to build AI data view", { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/choices", (req, res) => {
    const parsed = AiDataChoiceWriteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({ errors: parsed.error.issues.map((i) => ({ field: i.path.join(".") || "(body)", message: i.message })) });
      return;
    }
    const userId = req.userId!;
    const { provider, maxClass } = parsed.data;
    const recorded = RECORDED_DECISIONS.find((d) => d.provider === provider && d.maxClass === maxClass) ?? null;
    deps.choices.record({
      identityId: userId,
      provider,
      maxClass,
      decidedOn: recorded?.decidedOn ?? null,
      note: recorded?.note ?? null,
      confirmedAt: clock().toISOString(),
    });
    res.json(view(userId));
  });

  return router;
}
