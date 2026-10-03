# Phase 4 — Migration

Wire the gateway into the server, then move each call site onto it, then delete the old path. After Task 16, no code can reach a model except through the gateway. Spec sections: §6.7, §6.8, §10, §11, §12 (architecture test).

---

### Task 12: Container wiring and environment

**Files:**
- Create: `packages/agent-server/src/model-wiring.ts`
- Modify: `packages/agent-server/src/config/env.ts` (three new vars plus a refinement)
- Modify: `packages/agent-server/src/container.ts` (adds `modelGateway`, `aiDataChoices`, `modelAudit`; `llmPort` stays until Task 16)
- Modify: `packages/agent-server/src/container.test.ts` and `config/env.test.ts` (stub `MODEL_AUDIT_HMAC_KEY`)
- Test: `packages/agent-server/src/model-wiring.test.ts`

**Interfaces:**
- Consumes: `createModelGateway`, `parseProviderOverrides`, `Fingerprinter`, `ModelRouting` (Phase 2); `DeepSeekProvider`, `AnthropicProvider` (Task 10); `SqliteModelAuditRepository`, `SqliteAiDataChoiceRepository` (Task 8).
- Produces:
  - `createModelWiring(env: Env, deps: { db: Database.Database; logger: Logger }): { gateway: ModelGateway | null; routing: ModelRouting | null; choices: AiDataChoiceRepository; audit: ModelAuditRepository; configuredProviders: ProviderId[] }`
  - `AppContainer.modelGateway: ModelGateway | null`, `AppContainer.aiDataChoices`, `AppContainer.modelAudit`, `AppContainer.modelRouting: ModelRouting | null`
  - Env: `MODEL_PROVIDER_OVERRIDES?: string`, `MODEL_AUDIT_HMAC_KEY?: string`, `MODEL_AUDIT_HMAC_KEY_VERSION: number` (default 1)

Routing from the existing variables:
- `standard` = `LLM_PROVIDER`;
- `reasoning` = `LLM_REASONING_PROVIDER_PREMIUM` when it is not `none`, otherwise `LLM_PROVIDER`;
- `shadow` = `LLM_SHADOW_PROVIDER` when it is not `none`.

Models:
- `deepseek` = `{ standard: DEEPSEEK_CLASSIFIER_MODEL, reasoning: DEEPSEEK_SYNTHESIS_MODEL }`;
- `anthropic` = `{ standard: LLM_CLASSIFIER_MODEL, reasoning: LLM_SYNTHESIS_MODEL }`.

Timeouts: `{ standard: LLM_CLASSIFIER_TIMEOUT_MS, reasoning: LLM_SYNTHESIS_TIMEOUT_MS }`. `maxRetries` = `LLM_MAX_RETRIES`.

- [ ] **Step 1: Write the failing tests**

`model-wiring.test.ts`:

```ts
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
});
```

Add to `config/env.test.ts`:

```ts
it("requires MODEL_AUDIT_HMAC_KEY (32+ characters) once any model provider key is set", () => {
  stubRequired(); // the file's existing helper for required vars
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
```

If `env.test.ts` has no `stubRequired` helper, inline the same stubs as `baseEnv()` above.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @oneon/agent-server exec vitest run src/model-wiring.test.ts src/config/env.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `env.ts`, add to the schema:

```ts
  MODEL_PROVIDER_OVERRIDES: z.string().optional(),
  MODEL_AUDIT_HMAC_KEY: z.string().optional(),
  MODEL_AUDIT_HMAC_KEY_VERSION: z.coerce.number().int().positive().default(1),
```

In the existing `superRefine`, add:

```ts
  if ((data.ANTHROPIC_API_KEY || data.DEEPSEEK_API_KEY) && (!data.MODEL_AUDIT_HMAC_KEY || data.MODEL_AUDIT_HMAC_KEY.length < 32)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["MODEL_AUDIT_HMAC_KEY"],
      message: "MODEL_AUDIT_HMAC_KEY (at least 32 characters) is required when a model provider key is set. Generate with: openssl rand -base64 32",
    });
  }
```

`model-wiring.ts`:

```ts
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
export function createModelWiring(env: Env, deps: { db: Database.Database; logger: Logger }) {
  const choices: AiDataChoiceRepository = new SqliteAiDataChoiceRepository(deps.db);
  const audit: ModelAuditRepository = new SqliteModelAuditRepository(deps.db);
  const breaker = { failureThreshold: env.CB_FAILURE_THRESHOLD, resetTimeoutMs: env.CB_RESET_TIMEOUT_MS };
  const providers: Partial<Record<ProviderId, ModelProvider>> = {};
  if (env.DEEPSEEK_API_KEY) providers.deepseek = new DeepSeekProvider({ apiKey: env.DEEPSEEK_API_KEY, circuitBreaker: breaker, logger: deps.logger });
  if (env.ANTHROPIC_API_KEY) providers.anthropic = new AnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY, circuitBreaker: breaker, logger: deps.logger });
  const configuredProviders = Object.keys(providers) as ProviderId[];

  const overrides = parseProviderOverrides(env.MODEL_PROVIDER_OVERRIDES); // throws: the server refuses to start (spec §6.7)
  const standard = env.LLM_PROVIDER as ProviderId;
  if (!providers[standard]) {
    deps.logger.warn("Model gateway: disabled (no key for LLM_PROVIDER)", { provider: standard });
    return { gateway: null as ModelGateway | null, routing: null as ModelRouting | null, choices, audit, configuredProviders };
  }
  const routing: ModelRouting = {
    standard,
    reasoning: env.LLM_REASONING_PROVIDER_PREMIUM !== "none" ? (env.LLM_REASONING_PROVIDER_PREMIUM as ProviderId) : standard,
    ...(env.LLM_SHADOW_PROVIDER !== "none" ? { shadow: env.LLM_SHADOW_PROVIDER as ProviderId } : {}),
  };
  const gateway = createModelGateway({
    providers,
    overrides,
    routing,
    models: {
      ...(env.DEEPSEEK_API_KEY ? { deepseek: { standard: env.DEEPSEEK_CLASSIFIER_MODEL!, reasoning: env.DEEPSEEK_SYNTHESIS_MODEL! } } : {}),
      ...(env.ANTHROPIC_API_KEY ? { anthropic: { standard: env.LLM_CLASSIFIER_MODEL, reasoning: env.LLM_SYNTHESIS_MODEL } } : {}),
    },
    choices,
    audit,
    fingerprinter: new Fingerprinter(env.MODEL_AUDIT_HMAC_KEY!, env.MODEL_AUDIT_HMAC_KEY_VERSION),
    maxRetries: env.LLM_MAX_RETRIES,
    timeouts: { standard: env.LLM_CLASSIFIER_TIMEOUT_MS, reasoning: env.LLM_SYNTHESIS_TIMEOUT_MS },
    logger: deps.logger,
  });
  deps.logger.info("Model gateway: ✓ active", { routing, overrides: Object.fromEntries(overrides) });
  return { gateway, routing, choices, audit, configuredProviders };
}
```

In `container.ts`, after the database is ready, call `createModelWiring(env, { db, logger })`. Put its `gateway`, `routing`, `choices` and `audit` on the container as `modelGateway`, `modelRouting`, `aiDataChoices` and `modelAudit`. In `container.test.ts`'s `stubEnv()`, add `vi.stubEnv("MODEL_AUDIT_HMAC_KEY", "test-model-audit-key-at-least-32-chars");`.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @oneon/infrastructure build && pnpm --filter @oneon/agent-server exec vitest run src/model-wiring.test.ts src/config/env.test.ts src/container.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite and commit**

```bash
git add packages/agent-server
git commit -m "feat(ai-boundary): wire the model gateway into the container from existing LLM settings"
```

---

### Task 13: Email classification through the gateway

Spec §10.1, §10.3. Covers the processing cycle and `classifyItem`. Review Focus 2 lives here.

**Files:**
- Create: `packages/application/src/ai-boundary/requests/email.ts`
- Create: `packages/application/src/ai-boundary/requests/index.ts`
- Create: `packages/application/src/ai-boundary/__tests__/stub-gateway.ts`
- Modify: `packages/application/src/ai-boundary/index.ts` (export `requests`)
- Modify: `packages/application/src/usecases/run-processing-cycle.ts`
- Modify: `packages/application/src/usecases/classify-item.ts`, `process-unclassified-items.ts`
- Modify: `packages/agent-server/src/index.ts` (pass `modelGateway` into the cycle)
- Test: `packages/application/src/ai-boundary/requests/email.test.ts`; update `run-processing-cycle.test.ts`, `classify-item.test.ts`, `process-unclassified-items.test.ts`

**Interfaces:**
- Consumes: `ModelGateway`, `GatewayResult`, `ClassificationOutput` (earlier tasks).
- Produces:
  - `emailClassificationRequest(item: Pick<InboundItem, "from" | "subject" | "bodyPreview" | "receivedAt" | "source">): ModelRequest`
  - `RunProcessingCycleDeps.modelGateway: ModelGateway`, replacing `llmPort`
  - `CycleSummary.classification.pausedByPolicy: number`
  - `ClassifyItemDeps.modelGateway: ModelGateway`, replacing `llmPort`. `classifyItem` throws `ClassificationPausedError` when the gateway denies the call.
  - Test helper `stubGateway(opts: { limit?: DataClass | null; respond?: (req: ModelRequest) => GatewayResult }): ModelGateway & { requests: ModelRequest[] }`, plus `answered(json)`, `denied(reason)` and `blocked(reason)` result builders

- [ ] **Step 1: Write the request builder test and the stub**

`requests/email.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { emailClassificationRequest } from "./email.js";
import { decide } from "../decide.js";
import { PROVIDER_REGISTRY } from "../providers.js";

const item = { from: "ama@x.com", subject: "Invoice", bodyPreview: "Pay by Friday", receivedAt: "2026-10-03T09:00:00Z", source: "gmail" as const };

describe("emailClassificationRequest", () => {
  it("sends exactly the five declared fields with their classes", () => {
    const req = emailClassificationRequest(item);
    expect(req).toMatchObject({ purpose: "email_classification", output: "json" });
    const fields = (req.parts[0] as { rows: Array<{ fields: Array<{ name: string; class: string }> }> }).rows[0].fields;
    expect(fields.map((f) => [f.name, f.class])).toEqual([
      ["from", "D2"],
      ["subject", "D2"],
      ["bodyPreview", "D2"],
      ["receivedAt", "D1"],
      ["source", "D0"],
    ]);
  });
  it("is allowed after a D2 opt-in and denied at the D1 default", () => {
    const run = (choiceLimit: "D1" | "D2") =>
      decide({ context: { kind: "personal", identityId: "u1" }, request: emailClassificationRequest(item), provider: { entry: PROVIDER_REGISTRY.deepseek }, choiceLimit }).kind;
    expect(run("D2")).toBe("allow");
    expect(run("D1")).toBe("deny");
  });
});
```

`__tests__/stub-gateway.ts`:

```ts
import type { DenyReason } from "../decide.js";
import type { OutputBlockReason } from "../answer-check.js";
import type { GatewayResult, ModelGateway } from "../gateway.js";
import type { DataClass, ModelRequest } from "../types.js";

export const answered = (json: unknown, text = JSON.stringify(json)): GatewayResult => ({ kind: "answered", text, json, withheld: [], decisionId: "d" });
export const denied = (reason: DenyReason): GatewayResult => ({ kind: "denied", reason, withheld: [], decisionId: "d" });
export const blocked = (reason: OutputBlockReason): GatewayResult => ({ kind: "blocked", reason, withheld: [], decisionId: "d" });

export function stubGateway(opts: { limit?: DataClass | null; respond?: (req: ModelRequest) => GatewayResult } = {}) {
  const requests: ModelRequest[] = [];
  const gateway: ModelGateway & { requests: ModelRequest[] } = {
    requests,
    beginTurn: () => ({
      async call(req) {
        requests.push(req);
        return opts.respond ? opts.respond(req) : denied("required_part_withheld");
      },
      restoreToolParams: (params) => ({ ok: true, params }),
      effectiveLimit: () => (opts.limit === undefined ? "D2" : opts.limit),
    }),
  };
  return gateway;
}
```

- [ ] **Step 2: Rewrite the cycle tests for the gateway, adding the new cases**

In `run-processing-cycle.test.ts`, change `createDeps()` so it provides `modelGateway: stubGateway({ respond: () => answered(currentClassification) })` instead of `llmPort`. `currentClassification` is a `let` variable at the top of the file that tests reassign wherever they previously called `vi.mocked(deps.llmPort.classify).mockResolvedValue(X)`. Replace each `mockRejectedValue(err)` with `respond: () => blocked("invalid_output")`. Then add:

```ts
it("pauses classification without touching items when the policy limit is below D2 (spec §10.3)", async () => {
  const item1 = makeItem("item-1");
  const deps = createDeps({ modelGateway: stubGateway({ limit: "D1" }) });
  vi.mocked(deps.inboundItemRepo.findUnclassified).mockReturnValue([item1]);
  const result = await runProcessingCycle(deps, defaultOptions());
  expect(result.classification).toMatchObject({ classified: 0, failed: 0, pausedByPolicy: 1 });
  expect(deps.inboundItemRepo.incrementClassifyAttempts).not.toHaveBeenCalled();
  expect((deps.modelGateway as ReturnType<typeof stubGateway>).requests).toHaveLength(0);
});

it("counts a denied call as paused, not as a failed attempt", async () => {
  const item1 = makeItem("item-1");
  const deps = createDeps({ modelGateway: stubGateway({ respond: () => denied("secret_present") }) });
  vi.mocked(deps.inboundItemRepo.findUnclassified).mockReturnValue([item1]);
  const result = await runProcessingCycle(deps, defaultOptions());
  expect(result.classification).toMatchObject({ pausedByPolicy: 1, failed: 0 });
  expect(deps.inboundItemRepo.incrementClassifyAttempts).not.toHaveBeenCalled();
});

it("counts a blocked answer as a failed attempt", async () => {
  const item1 = makeItem("item-1");
  const deps = createDeps({ modelGateway: stubGateway({ respond: () => blocked("invalid_output") }) });
  vi.mocked(deps.inboundItemRepo.findUnclassified).mockReturnValue([item1]);
  const result = await runProcessingCycle(deps, defaultOptions());
  expect(result.classification.failed).toBe(1);
});
```

Add the Review Focus 2 case, using the real gateway:

```ts
import { createModelGateway } from "../ai-boundary/gateway.js";
import { Fingerprinter } from "../ai-boundary/fingerprints.js";
import { InMemoryChoices, InMemoryModelAudit } from "../ai-boundary/__tests__/in-memory-audit.js";
import { FakeProvider } from "../ai-boundary/__tests__/fake-provider.js";

it("classifies after opt-in and pauses again after the person revokes it (Review Focus 2)", async () => {
  const choices = new InMemoryChoices();
  const gateway = createModelGateway({
    providers: { deepseek: new FakeProvider("deepseek", [JSON.stringify({ category: "work", priority: 3, summary: "s", actionItems: [], followUpNeeded: false, deadlines: [] })]) },
    overrides: new Map(),
    routing: { standard: "deepseek", reasoning: "deepseek" },
    models: { deepseek: { standard: "s", reasoning: "r" } },
    choices,
    audit: new InMemoryModelAudit(),
    fingerprinter: new Fingerprinter("k".repeat(32), 1),
    maxRetries: 0,
    timeouts: { standard: 1000, reasoning: 1000 },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  choices.record({ identityId: "user-1", provider: "deepseek", maxClass: "D2", decidedOn: "2026-10-03", note: null, confirmedAt: "t1" });
  const first = createDeps({ modelGateway: gateway, userId: "user-1" });
  vi.mocked(first.inboundItemRepo.findUnclassified).mockReturnValue([makeItem("item-1")]);
  vi.mocked(first.classificationRepo.create).mockReturnValue(makeClassification("item-1"));
  expect((await runProcessingCycle(first, defaultOptions())).classification.classified).toBe(1);

  choices.record({ identityId: "user-1", provider: "deepseek", maxClass: "D1", decidedOn: null, note: null, confirmedAt: "t2" });
  const second = createDeps({ modelGateway: gateway, userId: "user-1" });
  vi.mocked(second.inboundItemRepo.findUnclassified).mockReturnValue([makeItem("item-2")]);
  expect((await runProcessingCycle(second, defaultOptions())).classification).toMatchObject({ classified: 0, pausedByPolicy: 1 });
});
```

If `createDeps` does not take overrides, make it accept `Partial<RunProcessingCycleDeps>` and spread them last.

- [ ] **Step 3: Run to verify the new tests fail**

Run: `pnpm --filter @oneon/application exec vitest run src/ai-boundary/requests src/usecases/run-processing-cycle.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement**

`requests/email.ts`:

```ts
import type { InboundItem } from "@oneon/domain";
import type { ModelRequest } from "../types.js";

/** Spec §10.1: exactly five fields. Free text is D2; the sender is a person entity. */
export function emailClassificationRequest(item: Pick<InboundItem, "from" | "subject" | "bodyPreview" | "receivedAt" | "source">): ModelRequest {
  return {
    purpose: "email_classification",
    output: "json",
    parts: [
      {
        kind: "record",
        source: "email",
        rows: [
          {
            fields: [
              { name: "from", class: "D2", value: item.from, entity: { type: "person", id: item.from } },
              { name: "subject", class: "D2", value: item.subject, freeText: true },
              { name: "bodyPreview", class: "D2", value: item.bodyPreview, freeText: true },
              { name: "receivedAt", class: "D1", value: item.receivedAt },
              { name: "source", class: "D0", value: item.source },
            ],
          },
        ],
      },
    ],
  };
}
```

`requests/index.ts`: `export * from "./email.js";`

In `run-processing-cycle.ts`:
1. Replace `llmPort: LLMPort` with `modelGateway: ModelGateway` in `RunProcessingCycleDeps`.
2. Add `pausedByPolicy: number` to the summary's `classification`, initialised to `0`.
3. Before the classification loop:

```ts
    const turn = () => deps.modelGateway.beginTurn({ kind: "personal", identityId: deps.userId }, { channel: "background" });
    const limit = turn().effectiveLimit("email_classification");
    const paused = limit === null || classRank(limit) < classRank("D2");
    if (paused) {
      summary.classification.pausedByPolicy = items.length;
      logger.info("Email classification paused by AI data policy", { userId: deps.userId, effectiveLimit: limit });
    }
```

   Wrap the per-item classification in `if (!paused) { … }`.
4. Replace the `deps.llmPort.classify({...})` call with:

```ts
      const result = await turn().call(emailClassificationRequest(item));
      if (result.kind === "denied") {
        summary.classification.pausedByPolicy++;
        logger.info("Email classification denied by AI data policy", { itemId: item.id, reason: result.reason });
        continue;
      }
      if (result.kind !== "answered") throw new Error(`Classification ${result.kind}: ${result.kind === "blocked" ? result.reason : result.message}`);
      const classifyResult = result.json as ClassificationOutput;
```

   The existing `catch` keeps counting `failed` and incrementing attempts for blocked and failed calls. The daily call counter still increments only after a successful classification.

In `classify-item.ts`: replace `llmPort` with `modelGateway: ModelGateway`. Call `modelGateway.beginTurn({ kind: "personal", identityId: item.userId ?? "" }).call(emailClassificationRequest(item))`. On `denied`, throw `new ClassificationPausedError(result.reason)` (a new exported class in the same file) without incrementing attempts. On `blocked` or `failed`, keep the existing failure path, which increments attempts and rethrows. In `process-unclassified-items.ts`, catch `ClassificationPausedError`, count it in a new `paused` total, and continue.

In `agent-server/src/index.ts`, pass `modelGateway: container.modelGateway!` where the cycle deps passed `llmPort`. The checks `if (!container.llmPort)` around the cycle become `if (!container.modelGateway)`.

- [ ] **Step 5: Run to verify everything passes**

Run: `pnpm --filter @oneon/application build && pnpm --filter @oneon/application exec vitest run src/usecases src/ai-boundary`
Expected: PASS.

- [ ] **Step 6: Full suite and commit**

```bash
git add packages/application packages/agent-server
git commit -m "feat(ai-boundary): route email classification through the gateway and pause it by policy"
```

---

### Task 14: Chat through the gateway

Spec §10.1, §10.2, §7.2, §7.6. Covers intent extraction and the chat reply. Review Focus 1, 4, 6 and 7 live here.

**Files:**
- Create: `packages/application/src/ai-boundary/requests/chat.ts`
- Modify: `packages/application/src/ai-boundary/requests/index.ts`
- Modify: `packages/application/src/usecases/run-intent-loop.ts`, `synthesize-response.ts`, `send-chat-message.ts`
- Delete: `packages/application/src/usecases/build-chat-context.ts` and `build-chat-context.test.ts` (replaced by `requests/chat.ts`), plus `buildSynthesisPrompt` and its tests in `synthesize-response.test.ts`
- Modify: `packages/application/src/usecases/index.ts` (drop the removed exports)
- Modify: `packages/agent-server/src/routes/chat.route.ts`, `routes/index.ts` (pass `modelGateway` instead of `intentExtractor`/`synthesizer`)
- Test: `packages/application/src/ai-boundary/requests/chat.test.ts`; update `run-intent-loop.test.ts`, `synthesize-response.test.ts`, `send-chat-message.test.ts`, `chat.route.test.ts`

**Interfaces:**
- Consumes: `ModelTurn`, `ModelGateway`, `toolResultToRecord`, `ToolRegistry` (earlier tasks).
- Produces:
  - `historyTurns(history: ConversationMessage[]): HistoryTurn[]`
  - `resolvePreferredSalutation(persona: ChatPersonaProfile): string` (moved from `build-chat-context.ts`)
  - `buildIntentRequest(input: { userMessage: string; history: ConversationMessage[]; toolDefinitions: ToolDescriptor[]; stats: ChatContextStats; now: Date; timezone: string; persona: ChatPersonaProfile | null; toolCalls: ToolCallRecord[]; registry: ToolRegistry }): ModelRequest`
  - `buildChatReplyRequest(input: { userMessage: string; history: ConversationMessage[]; persona: ChatPersonaProfile | null; toolCalls: ToolCallRecord[]; registry: ToolRegistry }): ModelRequest`
  - `ChatContextStats`, `ToolCallRecord` and `ChatPersonaProfile` move to `requests/chat.ts`, re-exported under their old names from `usecases/index.ts`.
  - `RunIntentLoopDeps.modelTurn: ModelTurn`, replacing `intentExtractor`. `StopReason` gains `"policy_denied"`.
  - `synthesizeResponse(deps: { modelTurn: ModelTurn; logger }, input): Promise<{ kind: "answered"; response: SynthesisResponse; dataWithheld: boolean } | { kind: "unavailable"; reason: string; dataWithheld: boolean }>`
  - `SendChatMessageDeps.modelGateway?: ModelGateway | null`, replacing `intentExtractor` and `synthesizer`
  - `DATA_WITHHELD_NOTE = "Some details weren't shared with the AI under your AI data settings."`

- [ ] **Step 1: Write the failing request-builder tests**

`requests/chat.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildChatReplyRequest, buildIntentRequest, historyTurns } from "./chat.js";
import { createToolRegistry } from "../../tools/tool-registry.js";
import { EMAIL_ENTRY_FIELDS } from "../../tools/output-schema.js";
import { z } from "zod";

const registry = createToolRegistry();
registry.register({
  name: "list_inbox",
  version: "1",
  description: "List emails",
  inputSchema: z.object({}),
  output: { fields: EMAIL_ENTRY_FIELDS, summaryClass: "D1" },
  execute: () => ({ data: [], summary: "" }),
});
const stats = { totalInboxItems: 3, unreadUrgentCount: 1, pendingActionsCount: 0, upcomingDeadlinesCount: 2, followUpCount: 0 };
const history = [
  { id: "m1", role: "user", content: "hi" },
  { id: "m2", role: "assistant", content: "Ama owes you" },
] as never;
const call = {
  id: "c1", round: 1, tool: "list_inbox", parameters: {}, error: null, durationMs: 1, executedAt: "t",
  result: { data: [{ id: "i1", subject: "Invoice", from: "ama@x.com", source: "gmail", receivedAt: "t", category: "work", priority: 2, summary: "s" }], summary: "Found 1 inbox item." },
};

describe("chat requests", () => {
  it("maps conversation history to user and assistant turns", () => {
    expect(historyTurns(history)).toEqual([{ role: "user", text: "hi" }, { role: "assistant", text: "Ama owes you" }]);
  });

  it("builds the intent request: catalog, context, history, message, tool results", () => {
    const req = buildIntentRequest({
      userMessage: "inbox?", history, toolDefinitions: [{ name: "list_inbox", description: "List emails" }], stats,
      now: new Date("2026-10-03T10:00:00Z"), timezone: "Africa/Accra", persona: null, toolCalls: [call], registry,
    });
    expect(req.purpose).toBe("intent_extraction");
    expect(req.parts.map((p) => (p.kind === "record" ? `record:${p.source}` : p.kind))).toEqual([
      "tool_catalog", "record:context", "history", "user_message", "record:tool:list_inbox",
    ]);
  });

  it("builds the reply request with a persona record and no tool catalog", () => {
    const req = buildChatReplyRequest({
      userMessage: "inbox?", history, toolCalls: [call], registry,
      persona: { preferredName: "Gerry", nickname: null, salutationMode: "sir_with_name", communicationStyle: "concise" } as never,
    });
    expect(req.purpose).toBe("chat_reply");
    const persona = req.parts.find((p) => p.kind === "record" && p.source === "persona");
    expect(persona).toMatchObject({ rows: [{ fields: [{ name: "salutation", class: "D1", value: "Sir Gerry" }, { name: "communicationStyle", class: "D1", value: "concise" }] }] });
  });

  it("turns a failed tool call into a tool_error record", () => {
    const req = buildChatReplyRequest({ userMessage: "x", history: [], persona: null, toolCalls: [{ ...call, result: null, error: "Calendar not configured" }], registry });
    expect(req.parts.find((p) => p.kind === "record" && p.source === "tool_error")).toBeDefined();
  });
});
```

- [ ] **Step 2: Rewrite the loop and synthesis tests, adding Review Focus 1 and 4**

In `run-intent-loop.test.ts`, replace the `intentExtractor` mock with a `modelTurn` built from `stubGateway({ respond }).beginTurn(...)`. Each `extractIntents` mock result `X` becomes `respond: () => answered(X)`. An `extractIntents` rejection becomes `respond: () => blocked("invalid_output")`. Add:

```ts
it("skips an intent whose placeholder was never issued and runs the others (Review Focus 4)", async () => {
  const turn = {
    call: vi.fn().mockResolvedValueOnce(answered([{ tool: "get_customer", parameters: { customerId: "CUSTOMER_9" } }, { tool: "list_inbox", parameters: {} }])).mockResolvedValue(answered([{ tool: "none", parameters: {} }])),
    restoreToolParams: (p: Record<string, unknown>) => (JSON.stringify(p).includes("CUSTOMER_9") ? { ok: false as const, token: "CUSTOMER_9" } : { ok: true as const, params: p }),
    effectiveLimit: () => "D2" as const,
  };
  const result = await runIntentLoop({ modelTurn: turn, toolRegistry: registryWith("get_customer", "list_inbox"), logger }, baseInput());
  expect(result.toolCalls.map((c) => c.tool)).toEqual(["list_inbox"]);
  expect(logger.warn).toHaveBeenCalledWith("Model used an unknown placeholder", expect.objectContaining({ tool: "get_customer", token: "CUSTOMER_9" }));
});

it("stops with policy_denied when the gateway denies the intent call", async () => {
  const turn = stubGateway({ respond: () => denied("required_part_withheld") }).beginTurn({ kind: "personal", identityId: "u1" });
  expect((await runIntentLoop({ modelTurn: turn, toolRegistry: registryWith(), logger }, baseInput())).stopped).toBe("policy_denied");
});
```

Add Review Focus 6 (spec §7.6 AX1) in the same file. The turn's `restoreToolParams` is stubbed here; Task 9 already tests restoration from a real mapping. This test proves the loop hands the tool the restored parameters:

```ts
it("hands an action tool the real identifier, never the placeholder (Review Focus 6)", async () => {
  const seen: unknown[] = [];
  const registry = registryWith();
  registry.register({
    name: "create_calendar_event", version: "1", description: "Request an event", inputSchema: z.object({}).passthrough(),
    output: { fields: { action: { class: "D1" } }, summaryClass: "D2" },
    execute: (input: unknown) => { seen.push(input); return { data: null, summary: "ok" }; },
  });
  const turn = {
    call: vi.fn().mockResolvedValueOnce(answered([{ tool: "create_calendar_event", parameters: { title: "Sync", attendees: ["PERSON_1"] } }])).mockResolvedValue(answered([{ tool: "none", parameters: {} }])),
    restoreToolParams: (p: Record<string, unknown>) => ({ ok: true as const, params: JSON.parse(JSON.stringify(p).replaceAll("PERSON_1", "ama@x.com")) as Record<string, unknown> }),
    effectiveLimit: () => "D1" as const,
  };
  await runIntentLoop({ modelTurn: turn, toolRegistry: registry, logger }, baseInput());
  expect(seen).toEqual([expect.objectContaining({ attendees: ["ama@x.com"] })]);
  expect(JSON.stringify(seen)).not.toContain("PERSON_1");
});
```

`registryWith(...names)` and `baseInput()` are small helpers in the test file. `registryWith` registers tools that return `{ data: [], summary: "ok" }` with `output: { fields: {}, summaryClass: "D1" }`. `baseInput` returns the input object the existing tests already build.

In `send-chat-message.test.ts`, add Review Focus 1 with the real gateway and no opt-in:

```ts
it("still answers at the D1 default, leaving earlier assistant replies out (Review Focus 1)", async () => {
  const provider = new FakeProvider("deepseek", [JSON.stringify([{ tool: "none", parameters: {} }])]);
  const gateway = createModelGateway({ /* same deps as the Task 13 Review Focus 2 test, with this provider and an empty InMemoryChoices */ });
  const deps = createDeps({ modelGateway: gateway });
  seedHistory(deps, [{ role: "user", content: "hi" }, { role: "assistant", content: "Ama owes you GHS 400" }]);
  const result = await sendChatMessage(deps, { userId: "u1", message: "anything new?" });
  expect(result.response.length).toBeGreaterThan(0);
  expect(provider.calls[0].user).not.toContain("Ama owes you");
  expect(provider.calls[0].user).toContain("anything new?");
});
```

When writing the `createModelGateway` call, copy the full deps object from the Task 13 test, so the test file stays self-contained. `seedHistory` uses the file's existing conversation-repo fake.

Add Review Focus 7 (spec §7.6 AX5) in `send-chat-message.test.ts`:

```ts
it("still lists the requested action when the chat reply is denied (Review Focus 7)", async () => {
  const action = { id: "a1", actionType: "create_calendar_event", label: "Create calendar event", status: "awaiting_approval" };
  let intentRounds = 0;
  const gateway = stubGateway({
    respond: (req) =>
      req.purpose === "chat_reply"
        ? denied("required_part_withheld")
        : answered(intentRounds++ === 0 ? [{ tool: "create_calendar_event", parameters: { title: "Sync" } }] : [{ tool: "none", parameters: {} }]),
  });
  const deps = createDeps({
    modelGateway: gateway,
    toolRegistry: registryWithTool("create_calendar_event", { data: { action }, summary: "Waiting for your approval in Action Center." }),
  });
  const result = await sendChatMessage(deps, { userId: "u1", message: "book a sync" });
  expect(result.actions).toEqual([action]);
  expect(result.response).toContain("Waiting for your approval");
});
```

`registryWithTool(name, result)` is a small helper in the test file. It registers one tool that returns `result`, with `output: { fields: { action: { class: "D1" } }, summaryClass: "D2" }`.

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm --filter @oneon/application exec vitest run src/ai-boundary/requests src/usecases/run-intent-loop.test.ts src/usecases/send-chat-message.test.ts src/usecases/synthesize-response.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement `requests/chat.ts`**

```ts
import type { CommunicationStyle, ConversationMessage, SalutationMode } from "@oneon/domain";
import type { ToolRegistry } from "../../tools/tool-registry.js";
import { toolResultToRecord } from "../../tools/output-schema.js";
import type { HistoryTurn, ModelRequest, PromptPart, ToolDescriptor } from "../types.js";

export interface ChatContextStats {
  totalInboxItems: number;
  unreadUrgentCount: number;
  pendingActionsCount: number;
  upcomingDeadlinesCount: number;
  followUpCount: number;
}
export interface ToolCallRecord {
  id: string;
  round: number;
  tool: string;
  parameters: Record<string, unknown>;
  result: { data: unknown; summary: string } | null;
  error: string | null;
  durationMs: number;
  executedAt: string;
}
export interface ChatPersonaProfile {
  preferredName: string | null;
  nickname: string | null;
  salutationMode: SalutationMode;
  communicationStyle: CommunicationStyle;
}

export function resolvePreferredSalutation(persona: ChatPersonaProfile): string {
  if (persona.salutationMode === "sir") return "Sir";
  if (persona.salutationMode === "sir_with_name") return persona.preferredName ? `Sir ${persona.preferredName}` : "Sir";
  return persona.nickname ?? persona.preferredName ?? "Sir";
}

export function historyTurns(history: ConversationMessage[]): HistoryTurn[] {
  return history
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role as "user" | "assistant", text: m.content }));
}

function personaPart(persona: ChatPersonaProfile | null): PromptPart[] {
  if (!persona) return [];
  return [{
    kind: "record",
    source: "persona",
    rows: [{ fields: [
      { name: "salutation", class: "D1", value: resolvePreferredSalutation(persona) },
      { name: "communicationStyle", class: "D1", value: persona.communicationStyle },
    ] }],
  }];
}

function toolParts(toolCalls: ToolCallRecord[], registry: ToolRegistry): PromptPart[] {
  return toolCalls.map((call) => {
    const tool = registry.get(call.tool);
    if (call.result && tool) return toolResultToRecord(call.tool, tool.output, call.result);
    return {
      kind: "record",
      source: "tool_error",
      rows: [{ fields: [
        { name: "tool", class: "D0", value: call.tool },
        { name: "error", class: "D1", value: call.error ?? "Tool unavailable" },
      ] }],
    };
  });
}

export function buildIntentRequest(input: {
  userMessage: string;
  history: ConversationMessage[];
  toolDefinitions: ToolDescriptor[];
  stats: ChatContextStats;
  now: Date;
  timezone: string;
  persona: ChatPersonaProfile | null;
  toolCalls: ToolCallRecord[];
  registry: ToolRegistry;
}): ModelRequest {
  const s = input.stats;
  return {
    purpose: "intent_extraction",
    output: "json",
    parts: [
      { kind: "tool_catalog", tools: input.toolDefinitions },
      {
        kind: "record",
        source: "context",
        rows: [{ fields: [
          { name: "currentTime", class: "D1", value: input.now.toISOString() },
          { name: "timezone", class: "D1", value: input.timezone },
          { name: "totalInboxItems", class: "D1", value: s.totalInboxItems },
          { name: "unreadUrgentCount", class: "D1", value: s.unreadUrgentCount },
          { name: "pendingActionsCount", class: "D1", value: s.pendingActionsCount },
          { name: "upcomingDeadlinesCount", class: "D1", value: s.upcomingDeadlinesCount },
          { name: "followUpCount", class: "D1", value: s.followUpCount },
        ] }],
      },
      ...personaPart(input.persona),
      ...(input.history.length > 0 ? [{ kind: "history" as const, turns: historyTurns(input.history) }] : []),
      { kind: "user_message", text: input.userMessage },
      ...toolParts(input.toolCalls, input.registry),
    ],
  };
}

export function buildChatReplyRequest(input: {
  userMessage: string;
  history: ConversationMessage[];
  persona: ChatPersonaProfile | null;
  toolCalls: ToolCallRecord[];
  registry: ToolRegistry;
}): ModelRequest {
  return {
    purpose: "chat_reply",
    output: "json",
    parts: [
      ...personaPart(input.persona),
      ...(input.history.length > 0 ? [{ kind: "history" as const, turns: historyTurns(input.history) }] : []),
      { kind: "user_message", text: input.userMessage },
      ...toolParts(input.toolCalls.filter((c) => c.result !== null || c.error !== null), input.registry),
    ],
  };
}
```

- [ ] **Step 5: Implement the loop, synthesis and send changes**

In `run-intent-loop.ts`:
- `RunIntentLoopDeps` gets `modelTurn: ModelTurn` instead of `intentExtractor`; `StopReason` adds `"policy_denied"`.
- Each round replaces `buildChatContext` and `extractIntents` with:

```ts
    const result = await modelTurn.call(
      buildIntentRequest({ userMessage, history, toolDefinitions, stats, now, timezone, persona: persona ?? null, toolCalls: allToolCalls, registry: toolRegistry }),
    );
    if (result.kind === "denied") {
      logger.info("Intent extraction denied by AI data policy", { round, reason: result.reason });
      return { toolCalls: allToolCalls, rounds: round, stopped: "policy_denied" };
    }
    if (result.kind !== "answered") {
      logger.error("Intent extraction failed", { round, kind: result.kind });
      return { toolCalls: allToolCalls, rounds: round, stopped: "extraction_error" };
    }
    const rawIntents = result.json;
```

- Keep the existing `intentOutputSchema` validation on `rawIntents`.
- In the per-intent loop, before the dedupe check, add:

```ts
      const restored = modelTurn.restoreToolParams(intent.parameters);
      if (!restored.ok) {
        logger.warn("Model used an unknown placeholder", { tool: intent.tool, token: restored.token, round });
        continue;
      }
      intent = { ...intent, parameters: restored.params };
```

  Declare the loop variable with `let` so it can be reassigned. The existing strip-then-spread of `userId`, `turnId` and `turnExcerpt` stays after this.

In `synthesize-response.ts`, replace `buildSynthesisPrompt`, `synthesizer.synthesize` and `extractJsonFromText` with:

```ts
export const DATA_WITHHELD_NOTE = "Some details weren't shared with the AI under your AI data settings.";

export async function synthesizeResponse(
  deps: { modelTurn: ModelTurn; logger: Logger },
  input: { userMessage: string; toolCalls: ToolCallRecord[]; history: ConversationMessage[]; persona: ChatPersonaProfile | null; registry: ToolRegistry },
) {
  const result = await deps.modelTurn.call(buildChatReplyRequest(input));
  // History is context, not answer data: only tool data withheld from records earns the note.
  const dataWithheld = result.withheld.some((w) => w.part.startsWith("record:"));
  if (result.kind === "answered") return { kind: "answered" as const, response: result.json as SynthesisResponse, dataWithheld };
  deps.logger.warn("Chat reply unavailable", { kind: result.kind });
  return { kind: "unavailable" as const, reason: result.kind, dataWithheld: dataWithheld || result.kind === "denied" };
}
```

Delete `buildSynthesisPrompt`, `extractJsonFromText`, `SYNTHESIS_PROMPT_VERSION` and their tests, if nothing else imports them (check with grep).

In `send-chat-message.ts`:
- Deps get `modelGateway?: ModelGateway | null` instead of `intentExtractor`/`synthesizer`, and `canRunLoop = deps.modelGateway != null && deps.toolRegistry != null`.
- Create one turn per message: `const turn = deps.modelGateway!.beginTurn({ kind: "personal", identityId: userId }, { channel: "web" });`.
- Pass `modelTurn: turn` to `runIntentLoop`, and `{ modelTurn: turn, logger }` plus `registry: deps.toolRegistry!` to `synthesizeResponse`.
- On `answered`, the response is `response.answer`, followed by `\n\n${DATA_WITHHELD_NOTE}` when `dataWithheld`.
- On `unavailable`, use the existing tool-summary fallback, appending the note when `dataWithheld`.

In `chat.route.ts` and `routes/index.ts`, replace the `intentExtractor` and `synthesizer` deps with `modelGateway: container.modelGateway`. Register chat when `container.modelGateway` exists.

- [ ] **Step 6: Run to verify everything passes**

Run: `pnpm --filter @oneon/application build && pnpm --filter @oneon/application exec vitest run && pnpm --filter @oneon/agent-server exec vitest run src/routes/chat.route.test.ts`
Expected: PASS.

- [ ] **Step 7: Full suite and commit**

```bash
git add packages/application packages/agent-server
git commit -m "feat(ai-boundary): route chat intents and replies through the gateway with turn-scoped placeholders"
```

---

### Task 15: Daily briefing through the gateway

Spec §10.1, §10.3.

**Files:**
- Create: `packages/application/src/ai-boundary/requests/briefing.ts`
- Modify: `packages/application/src/ai-boundary/requests/index.ts`
- Modify: `packages/application/src/usecases/generate-daily-briefing.ts` (drop `buildBriefingPrompt`; `synthesizer` → `modelGateway`)
- Modify: `packages/application/src/tools/daily-briefing.ts`, `packages/agent-server/src/routes/index.ts`
- Test: `packages/application/src/ai-boundary/requests/briefing.test.ts`; update `generate-daily-briefing.test.ts` and `daily-briefing.test.ts`

**Interfaces:**
- Produces:
  - `buildBriefingRequest(data: BriefingData): ModelRequest`
  - `GenerateDailyBriefingDeps.modelGateway: ModelGateway | null`, replacing `synthesizer`
  - `GenerateDailyBriefingResult.aiWithheld: boolean`
  - `BRIEFING_WITHHELD_NOTE = "The AI summary was withheld under your AI data settings."`

- [ ] **Step 1: Write the failing tests**

`requests/briefing.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildBriefingRequest } from "./briefing.js";
import { decide } from "../decide.js";
import { PROVIDER_REGISTRY } from "../providers.js";

const data = {
  date: "2026-10-03",
  urgentItems: [{ id: "i1", subject: "Outage", from: "ops@x.com", source: "gmail", category: "urgent", priority: 1, summary: "Prod down" }],
  deadlines: [],
  pendingActions: [{ actionType: "notify", resourceId: "inbound_item:i1", riskLevel: "L1" }],
  calendar: { status: "connected" as const, events: [] },
};

describe("buildBriefingRequest", () => {
  it("builds the five records with their classes", () => {
    const req = buildBriefingRequest(data as never);
    expect(req).toMatchObject({ purpose: "daily_briefing", output: "text" });
    expect(req.parts.map((p) => (p as { source: string }).source)).toEqual(["briefing_meta", "urgent_items", "deadlines", "calendar", "pending_actions"]);
  });
  it("is denied at D1 because every section loses its descriptive fields (spec §10.3), and allowed at D2", () => {
    const run = (choiceLimit: "D1" | "D2") =>
      decide({ context: { kind: "personal", identityId: "u1" }, request: buildBriefingRequest(data as never), provider: { entry: PROVIDER_REGISTRY.deepseek }, choiceLimit });
    expect(run("D1")).toMatchObject({ kind: "deny", reason: "required_part_withheld" });
    expect(run("D2").kind).toBe("allow");
  });
});
```

In `generate-daily-briefing.test.ts`, replace the synthesizer mock with `stubGateway`, and add:

```ts
it("falls back to the structured summary and flags aiWithheld when the gateway denies", async () => {
  const deps = createDeps({ modelGateway: stubGateway({ respond: () => denied("required_part_withheld") }) });
  const result = await generateDailyBriefing(deps, { now: NOW, timezone: "UTC", userId: "u1" });
  expect(result.aiWithheld).toBe(true);
  expect(result.summary).toContain("Briefing for");
});
it("uses the fallback without calling a model when there is no user", async () => {
  const gateway = stubGateway({ respond: () => answered(null, "AI text") });
  const result = await generateDailyBriefing(createDeps({ modelGateway: gateway }), { now: NOW, timezone: "UTC" });
  expect(gateway.requests).toHaveLength(0);
  expect(result.aiWithheld).toBe(false);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @oneon/application exec vitest run src/ai-boundary/requests/briefing.test.ts src/usecases/generate-daily-briefing.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`requests/briefing.ts`:

```ts
import type { BriefingData } from "../../usecases/generate-daily-briefing.js";
import type { ClassifiedField, ModelRequest, PromptPart } from "../types.js";

const rec = (source: string, rows: ClassifiedField[][]): PromptPart => ({ kind: "record", source, rows: rows.map((fields) => ({ fields })) });

export function buildBriefingRequest(data: BriefingData): ModelRequest {
  return {
    purpose: "daily_briefing",
    output: "text",
    parts: [
      rec("briefing_meta", [[{ name: "date", class: "D1", value: data.date }, { name: "calendarStatus", class: "D1", value: data.calendar.status }]]),
      rec("urgent_items", data.urgentItems.map((i) => [
        { name: "id", class: "D1", value: i.id },
        { name: "subject", class: "D2", value: i.subject, freeText: true },
        { name: "from", class: "D2", value: i.from, entity: { type: "person", id: i.from } },
        { name: "source", class: "D1", value: i.source },
        { name: "category", class: "D1", value: i.category },
        { name: "priority", class: "D1", value: i.priority },
        { name: "summary", class: "D2", value: i.summary, freeText: true },
      ])),
      rec("deadlines", data.deadlines.map((d) => [
        { name: "dueDate", class: "D1", value: d.dueDate },
        { name: "description", class: "D2", value: d.description, freeText: true },
        { name: "status", class: "D1", value: d.status },
        { name: "confidence", class: "D1", value: d.confidence },
      ])),
      rec("calendar", data.calendar.events.map((e) => [
        { name: "start", class: "D1", value: e.start },
        { name: "end", class: "D1", value: e.end },
        { name: "allDay", class: "D1", value: e.allDay },
        { name: "title", class: "D2", value: e.title, freeText: true },
        { name: "location", class: "D2", value: e.location },
        { name: "attendees", class: "D2", value: e.attendees },
        { name: "description", class: "D2", value: e.description, freeText: true },
      ])),
      rec("pending_actions", data.pendingActions.map((a) => [
        { name: "actionType", class: "D1", value: a.actionType },
        { name: "resourceId", class: "D1", value: a.resourceId },
        { name: "riskLevel", class: "D1", value: a.riskLevel },
      ])),
    ],
  };
}
```

In `generate-daily-briefing.ts`, replace step 5 ("Synthesize") with:

```ts
  let summary = buildFallbackSummary(data);
  let aiWithheld = false;
  if (deps.modelGateway && input.userId) {
    const result = await deps.modelGateway.beginTurn({ kind: "personal", identityId: input.userId }, { channel: "briefing" }).call(buildBriefingRequest(data));
    if (result.kind === "answered") summary = result.text;
    else if (result.kind === "denied") {
      aiWithheld = true;
      logger.info("Briefing AI summary withheld by policy", { reason: result.reason });
    } else logger.warn("Briefing synthesis failed, using fallback", { kind: result.kind });
  }
  return { data, summary, aiWithheld };
```

Delete `buildBriefingPrompt`, `BRIEFING_PROMPT_VERSION` (if now unused) and their tests. In `tools/daily-briefing.ts` and `routes/index.ts`, replace `synthesizer` with `modelGateway: container.modelGateway`, and register the tool when `container.modelGateway` exists. When `aiWithheld` is true, the tool's summary ends with `BRIEFING_WITHHELD_NOTE`.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @oneon/application build && pnpm --filter @oneon/application exec vitest run src/ai-boundary src/usecases src/tools`
Expected: PASS.

- [ ] **Step 5: Full suite and commit**

```bash
git add packages/application packages/agent-server
git commit -m "feat(ai-boundary): route the daily briefing through the gateway with a structured fallback"
```

---

### Task 16: Remove the old path and add architecture tests

Spec §5.5. After this task, the gateway is the only way to reach a model.

**Files:**
- Delete: `packages/infrastructure/src/llm/claude-classifier.adapter.ts`, `deepseek-classifier.adapter.ts`, `routing-llm.adapter.ts`, `shadow-llm.adapter.ts`, `classification.schema.ts`, and their `*.test.ts`
- Modify: `packages/infrastructure/src/llm/index.ts` (keep `deepseek-http-client`, `circuit-breaker` and `providers` exports)
- Modify: `packages/domain/src/ports/llm.port.ts` (remove `LLMPort`, `IntentExtractionPort`, `SynthesisPort`; delete the file and its re-export if `ClassificationResult` is unused too, otherwise keep only that type)
- Modify: `packages/agent-server/src/container.ts` (remove `llmPort`, `buildLlmAdapter` and their imports), `index.ts` and `routes/status.route.ts` (LLM status uses `modelGateway !== null`)
- Modify: `packages/agent-server/src/architecture.test.ts` (four new tests)

**Interfaces:**
- Produces: no new runtime code; four architecture tests.

- [ ] **Step 1: Write the failing architecture tests**

Add to `architecture.test.ts`, using its existing `ROOT`, `sourceFiles` and `posix` helpers:

```ts
  const allSources = () =>
    ["domain", "application", "infrastructure", "agent-server"].flatMap((pkg) => sourceFiles(join(ROOT, pkg, "src"))).map((f) => ({ path: posix(relative(ROOT, f)), text: readFileSync(f, "utf8") }));
  const isTest = (p: string) => /\.test\.ts$/.test(p) || /\/__tests__\//.test(p);

  it("only the gateway mints approved model calls (spec §5.5)", () => {
    const offenders = allSources()
      .filter((f) => /ApprovedModelCall\.mint\(/.test(f.text))
      .map((f) => f.path)
      .filter((p) => !isTest(p) && p !== "application/src/ai-boundary/gateway.ts" && p !== "application/src/ai-boundary/approved-call.ts");
    expect(offenders).toEqual([]);
  });

  it("nothing casts to ApprovedModelCall or Instruction outside their own modules", () => {
    const offenders = allSources()
      .filter((f) => /\bas\s+(ApprovedModelCall|Instruction)\b/.test(f.text))
      .map((f) => f.path)
      .filter((p) => !isTest(p) && !/^application\/src\/ai-boundary\/(instruction|approved-call)\.ts$/.test(p));
    expect(offenders).toEqual([]);
  });

  it("provider clients are constructed only by the model wiring", () => {
    const offenders = allSources()
      .filter((f) => /new\s+(DeepSeekProvider|AnthropicProvider)\(/.test(f.text))
      .map((f) => f.path)
      .filter((p) => !isTest(p) && p !== "agent-server/src/model-wiring.ts");
    expect(offenders).toEqual([]);
  });

  it("only provider clients import a model SDK or the model HTTP client", () => {
    const offenders = allSources()
      .filter((f) => /from\s+["'](@anthropic-ai\/sdk|[./]*deepseek-http-client(\.js)?)["']/.test(f.text))
      .map((f) => f.path)
      .filter((p) => !isTest(p) && !/^infrastructure\/src\/llm\/providers\//.test(p) && p !== "infrastructure/src/llm/index.ts");
    expect(offenders).toEqual([]);
  });
```

- [ ] **Step 2: Run to verify the import and construction tests fail while the old adapters exist**

Run: `pnpm --filter @oneon/agent-server exec vitest run src/architecture.test.ts`
Expected: FAIL on "only provider clients import a model SDK…", because the old adapters still import it.

- [ ] **Step 3: Delete the old path**

1. Delete the adapter files and tests listed above. Remove their exports from `infrastructure/src/llm/index.ts`.
2. In `container.ts`, delete `buildLlmAdapter`, the `llmPort` construction (primary, routing, shadow), the `llmPort` field, and the now-unused imports.
3. Grep for any remaining `llmPort`, `LLMPort`, `IntentExtractionPort`, `SynthesisPort`, `ClaudeClassifierAdapter`, `DeepSeekClassifierAdapter`, `RoutingLlmAdapter` and `ShadowLlmAdapter` across `packages/*/src`. Replace each use with `modelGateway`, or remove it.
4. Remove the ports from `domain/src/ports/llm.port.ts` and its re-export in `domain/src/ports/index.ts`. If nothing imports `ClassificationResult` any more, delete the file.
5. `routes/status.route.ts` and `index.ts`: report LLM as active when `container.modelGateway !== null`.

- [ ] **Step 4: Run to verify everything passes**

Run: `pnpm -r run build && pnpm --filter @oneon/agent-server exec vitest run src/architecture.test.ts`
Expected: PASS (all architecture tests).

- [ ] **Step 5: Full suite and commit**

```bash
git add -A packages
git commit -m "refactor(ai-boundary): remove the direct LLM adapters; the gateway is the only path to a model"
```
