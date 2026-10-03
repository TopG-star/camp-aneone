# Phase 5 — Surface

The AI data API, Settings → AI data with the opt-in confirmation, the dashboard notice, and the docs. Spec sections: §2.12, §8 (readers), §10.3.

---

### Task 17: AI data API

**Files:**
- Create: `packages/application/src/ai-boundary/recorded-decisions.ts`
- Modify: `packages/application/src/ai-boundary/index.ts`
- Create: `packages/contracts/src/ai-data.contract.ts`
- Modify: `packages/contracts/src/index.ts` (export it)
- Create: `packages/agent-server/src/routes/ai-data.route.ts`
- Modify: `packages/agent-server/src/routes/index.ts` (mount at `/api/ai-data` behind `...userAuth`)
- Test: `packages/agent-server/src/routes/ai-data.route.test.ts`

**Interfaces:**
- Consumes: `ModelGateway`, `ModelRouting`, `AiDataChoiceRepository`, `ModelAuditRepository`, `PROVIDER_REGISTRY`, `parseProviderOverrides` (earlier tasks).
- Produces:
  - `RECORDED_DECISIONS: Array<{ provider: ProviderId; maxClass: "D2"; decidedOn: string; note: string }>`, exactly one entry, with the values from the Global Constraints
  - Contracts: `AiDataProviderViewSchema`, `AiDataCallViewSchema`, `AiDataViewSchema` (and `type AiDataView`), `AiDataChoiceWriteSchema`
  - `createAiDataRouter(deps: { gateway: ModelGateway | null; routing: ModelRouting | null; overrides: Map<ProviderId, ProviderOverride>; configuredProviders: ProviderId[]; choices: AiDataChoiceRepository; audit: ModelAuditRepository; clock?: () => Date; logger: Logger }): Router`

Copy, verbatim:
- Email classification paused, no gateway: `No AI provider is configured.`
- Email classification paused by the limit: `Email classification needs your approval to send email content (D2) to ${label}. Choose D2 for ${label} in Settings → AI data to resume.`

Add `overrides` and `configuredProviders` to the object `createModelWiring` returns, so the route can show them.

- [ ] **Step 1: Write the contracts**

`ai-data.contract.ts`:

```ts
import { z } from "zod";

const ProviderIdSchema = z.enum(["deepseek", "anthropic"]);
const DataClassSchema = z.enum(["D0", "D1", "D2", "D3", "D4"]);

export const AiDataProviderViewSchema = z.object({
  id: ProviderIdSchema,
  label: z.string(),
  review: z.enum(["unreviewed", "reviewed"]),
  limits: z.object({ personal: DataClassSchema, tenant: DataClassSchema }),
  override: z.string().nullable(),
  configured: z.boolean(),
  personalChoice: z.enum(["D1", "D2"]),
  choiceConfirmedAt: z.string().nullable(),
});

export const AiDataCallViewSchema = z.object({
  callId: z.string(),
  at: z.string(),
  purpose: z.string(),
  channel: z.string().nullable(),
  provider: z.string(),
  decision: z.enum(["allow", "deny"]),
  effectiveLimit: DataClassSchema.nullable(),
  denyReason: z.string().nullable(),
  withheldCount: z.number().int(),
  alert: z.boolean(),
  outcome: z.enum(["answered", "blocked", "failed"]).nullable(),
});

export const AiDataViewSchema = z.object({
  providers: z.array(AiDataProviderViewSchema),
  pendingDecision: z.object({ provider: ProviderIdSchema, maxClass: z.literal("D2"), decidedOn: z.string(), note: z.string() }).nullable(),
  emailClassification: z.object({ active: z.boolean(), reason: z.string().nullable() }),
  recent: z.array(AiDataCallViewSchema),
});
export type AiDataView = z.infer<typeof AiDataViewSchema>;

export const AiDataChoiceWriteSchema = z.object({ provider: ProviderIdSchema, maxClass: z.enum(["D1", "D2"]) }).strict();
```

- [ ] **Step 2: Write the failing route tests**

`ai-data.route.test.ts`. It uses an in-memory SQLite DB with migrations, users `user-A` and `user-B`, and the `x-test-user` auth shim that `routes/__tests__/actions-test-app.ts` uses. Copy that setup.

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import Database from "better-sqlite3";
import { AiDataViewSchema } from "@oneon/contracts";
import { createModelGateway, Fingerprinter, type ModelProvider } from "@oneon/application";
import { runMigrations, SqliteAiDataChoiceRepository, SqliteModelAuditRepository } from "@oneon/infrastructure";
import { createAiDataRouter } from "./ai-data.route.js";

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
let app: express.Express;
let choices: SqliteAiDataChoiceRepository;

beforeEach(() => {
  const db = new Database(":memory:");
  runMigrations(db);
  db.prepare("INSERT INTO users (id, email) VALUES ('user-A', 'a@test.com'), ('user-B', 'b@test.com')").run();
  choices = new SqliteAiDataChoiceRepository(db);
  const audit = new SqliteModelAuditRepository(db);
  const provider: ModelProvider = { id: "deepseek", complete: async () => ({ text: "{}" }) };
  const routing = { standard: "deepseek" as const, reasoning: "deepseek" as const };
  const gateway = createModelGateway({
    providers: { deepseek: provider }, overrides: new Map(), routing, models: { deepseek: { standard: "s", reasoning: "r" } },
    choices, audit, fingerprinter: new Fingerprinter("k".repeat(32), 1), maxRetries: 0, timeouts: { standard: 1, reasoning: 1 }, logger,
  });
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as { userId?: string }).userId = req.header("x-test-user") ?? undefined; next(); });
  app.use("/api/ai-data", createAiDataRouter({ gateway, routing, overrides: new Map(), configuredProviders: ["deepseek"], choices, audit, logger }));
});

describe("AI data API", () => {
  it("shows the recorded 2026-10-03 decision as pending and email classification paused", async () => {
    const res = await request(app).get("/api/ai-data").set("x-test-user", "user-A").expect(200);
    expect(AiDataViewSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.pendingDecision).toMatchObject({ provider: "deepseek", maxClass: "D2", decidedOn: "2026-10-03" });
    expect(res.body.emailClassification).toEqual({
      active: false,
      reason: "Email classification needs your approval to send email content (D2) to DeepSeek. Choose D2 for DeepSeek in Settings → AI data to resume.",
    });
    expect(res.body.providers[0]).toMatchObject({ id: "deepseek", personalChoice: "D1", configured: true, review: "unreviewed" });
  });

  it("confirms the recorded decision with its date and note, and resumes email classification", async () => {
    const res = await request(app).post("/api/ai-data/choices").set("x-test-user", "user-A").send({ provider: "deepseek", maxClass: "D2" }).expect(200);
    expect(res.body.pendingDecision).toBeNull();
    expect(res.body.emailClassification).toEqual({ active: true, reason: null });
    expect(choices.current("user-A", "deepseek")).toMatchObject({
      maxClass: "D2",
      decidedOn: "2026-10-03",
      note: "Approved by Gerry in the 2026-10-03 design session for his personal email, pending confirmation after checking DeepSeek's current terms.",
    });
  });

  it("revokes by choosing D1", async () => {
    await request(app).post("/api/ai-data/choices").set("x-test-user", "user-A").send({ provider: "deepseek", maxClass: "D2" });
    const res = await request(app).post("/api/ai-data/choices").set("x-test-user", "user-A").send({ provider: "deepseek", maxClass: "D1" }).expect(200);
    expect(res.body.emailClassification.active).toBe(false);
    expect(choices.current("user-A", "deepseek")).toMatchObject({ maxClass: "D1", decidedOn: null, note: null });
  });

  it.each([
    [{ provider: "deepseek", maxClass: "D3" }],
    [{ provider: "openai", maxClass: "D2" }],
    [{ provider: "deepseek", maxClass: "D2", identityId: "user-B" }],
  ])("refuses %o with 422", async (body) => {
    await request(app).post("/api/ai-data/choices").set("x-test-user", "user-A").send(body).expect(422);
  });

  it("keeps each user's choices and calls separate", async () => {
    await request(app).post("/api/ai-data/choices").set("x-test-user", "user-A").send({ provider: "deepseek", maxClass: "D2" });
    const res = await request(app).get("/api/ai-data").set("x-test-user", "user-B").expect(200);
    expect(res.body.providers[0].personalChoice).toBe("D1");
    expect(res.body.pendingDecision).not.toBeNull();
    expect(res.body.recent).toEqual([]);
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm --filter @oneon/contracts build && pnpm --filter @oneon/agent-server exec vitest run src/routes/ai-data.route.test.ts`
Expected: FAIL (route missing).

- [ ] **Step 4: Implement**

`recorded-decisions.ts`:

```ts
import type { ProviderId } from "./types.js";

/** Decisions recorded in the design session; each takes effect only once the person confirms it in Settings → AI data (spec §2.12). */
export const RECORDED_DECISIONS: Array<{ provider: ProviderId; maxClass: "D2"; decidedOn: string; note: string }> = [
  {
    provider: "deepseek",
    maxClass: "D2",
    decidedOn: "2026-10-03",
    note: "Approved by Gerry in the 2026-10-03 design session for his personal email, pending confirmation after checking DeepSeek's current terms.",
  },
];
```

`ai-data.route.ts`:

```ts
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
    const reason = !deps.gateway
      ? "No AI provider is configured."
      : active
        ? null
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
```

In `routes/index.ts`, mount it after the action-definitions router: `app.use("/api/ai-data", ...userAuth, createAiDataRouter({ gateway: container.modelGateway, routing: container.modelRouting, overrides: container.modelOverrides, configuredProviders: container.modelProviders, choices: container.aiDataChoices, audit: container.modelAudit, logger }))`. Add `modelOverrides` and `modelProviders` to the container, taken from `createModelWiring`.

- [ ] **Step 5: Run to verify they pass**

Run: `pnpm --filter @oneon/application build && pnpm --filter @oneon/contracts build && pnpm --filter @oneon/agent-server exec vitest run src/routes/ai-data.route.test.ts`
Expected: PASS.

- [ ] **Step 6: Full suite and commit**

```bash
git add packages/application packages/contracts packages/agent-server
git commit -m "feat(ai-boundary): add the AI data API with opt-in confirmation and a content-free call log"
```

---

### Task 18: Settings → AI data and the dashboard notice

**Files:**
- Create: `packages/dashboard/src/lib/ai-data-ui.ts`
- Create: `packages/dashboard/src/components/settings/ai-data-settings.tsx`
- Modify: `packages/dashboard/src/lib/hooks.ts` (add `useAiData`)
- Modify: `packages/dashboard/src/app/settings/page.tsx` (render `<AiDataSettings />` right after `<ActionsSettings />`)
- Modify: `packages/dashboard/src/app/today/page.tsx` (notice when email classification is paused)
- Test: `packages/dashboard/src/lib/ai-data-ui.test.ts`

**Interfaces:**
- Consumes: `AiDataView` (Task 17), `apiFetch` with `{ redirectOnAuth: false }`.
- Produces:
  - `purposeLabel(purpose)`, `classLabel(cls)`, `callLabel(call)`, `pendingDecisionText(decision, label)`
  - `useAiData()`
  - `<AiDataSettings />` (section id `ai-data`)

Copy, verbatim:
- Class labels: `D1` → `Basic (no names or message content)`; `D2` → `Includes names and message content`.
- Purpose labels:
  - `email_classification` → `Email sorting`;
  - `intent_extraction` → `Chat: choosing tools`;
  - `chat_reply` → `Chat: writing the reply`;
  - `daily_briefing` → `Daily briefing`.
- Pending decision: `On ${date} you approved ${label} receiving your personal email content until this setting existed. Check ${label}'s current terms, then confirm or keep the basic level.`
- Buttons: `Confirm: include names and content`, `Keep basic`.
- Call labels:
  - `answered` → `Sent`;
  - `blocked` → `Answer blocked`;
  - `failed` → `Provider error`;
  - denied → `Not sent: ${denyReason}`.
- Today notice title: `Email sorting is paused`, followed by the API's `reason` and a link `Open AI data settings` to `/settings#ai-data`.

- [ ] **Step 1: Write the failing helper test**

```ts
import { describe, it, expect } from "vitest";
import { callLabel, classLabel, pendingDecisionText, purposeLabel } from "./ai-data-ui";

describe("AI data UI helpers", () => {
  it("labels classes and purposes in plain words", () => {
    expect(classLabel("D1")).toBe("Basic (no names or message content)");
    expect(classLabel("D2")).toBe("Includes names and message content");
    expect(purposeLabel("chat_reply")).toBe("Chat: writing the reply");
    expect(purposeLabel("something_new")).toBe("something_new");
  });
  it("labels call outcomes, including denials with their reason", () => {
    expect(callLabel({ decision: "allow", outcome: "answered", denyReason: null })).toBe("Sent");
    expect(callLabel({ decision: "deny", outcome: null, denyReason: "required_part_withheld" })).toBe("Not sent: required_part_withheld");
    expect(callLabel({ decision: "allow", outcome: "blocked", denyReason: null })).toBe("Answer blocked");
  });
  it("words the pending decision with its date and provider", () => {
    expect(pendingDecisionText({ decidedOn: "2026-10-03" }, "DeepSeek")).toBe(
      "On 3 Oct 2026 you approved DeepSeek receiving your personal email content until this setting existed. Check DeepSeek's current terms, then confirm or keep the basic level.",
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @oneon/dashboard exec vitest run src/lib/ai-data-ui.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`ai-data-ui.ts`:

```ts
const CLASS_LABELS: Record<string, string> = { D1: "Basic (no names or message content)", D2: "Includes names and message content" };
const PURPOSE_LABELS: Record<string, string> = {
  email_classification: "Email sorting",
  intent_extraction: "Chat: choosing tools",
  chat_reply: "Chat: writing the reply",
  daily_briefing: "Daily briefing",
};

export const classLabel = (cls: string): string => CLASS_LABELS[cls] ?? cls;
export const purposeLabel = (purpose: string): string => PURPOSE_LABELS[purpose] ?? purpose;

export function callLabel(call: { decision: "allow" | "deny"; outcome: "answered" | "blocked" | "failed" | null; denyReason: string | null }): string {
  if (call.decision === "deny") return `Not sent: ${call.denyReason ?? "policy"}`;
  if (call.outcome === "answered") return "Sent";
  if (call.outcome === "blocked") return "Answer blocked";
  if (call.outcome === "failed") return "Provider error";
  return "Sent";
}

export function pendingDecisionText(decision: { decidedOn: string }, label: string): string {
  const date = new Date(`${decision.decidedOn}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return `On ${date} you approved ${label} receiving your personal email content until this setting existed. Check ${label}'s current terms, then confirm or keep the basic level.`;
}
```

In `hooks.ts`:

```ts
export function useAiData(config?: SWRConfiguration) {
  return useSWR("/api/ai-data", fetcher, config);
}
```

`ai-data-settings.tsx` follows `actions-settings.tsx`:
- **Card:** a `<Card id="ai-data">` titled `AI data`, with the description `What Oneon may send to AI providers about you. Business data follows your pharmacy's settings.`
- **States:** a skeleton while loading, and `Couldn't load AI data settings.` on error.
- **Pending decision:** when `pendingDecision` is set, show an amber panel with `pendingDecisionText(...)` and the two buttons. They `POST /api/ai-data/choices` with `{ provider, maxClass: "D2" }` or `{ provider, maxClass: "D1" }`, using `apiFetch(..., { redirectOnAuth: false })`, then `mutate()`.
- **Provider rows** (`configured` only), each showing:
  - the label;
  - an `Unreviewed` badge when `review === "unreviewed"`;
  - `Suspended` when `override === "suspended"`;
  - a select of `D1` and `D2` using `classLabel`, which posts a choice on change;
  - `Confirmed ${date}` when `choiceConfirmedAt` is set.
- **Recent calls:** a compact list of up to 20 rows, each showing time, `purposeLabel`, provider, `callLabel`, and `· ${withheldCount} held back` when greater than 0.
- **Rules:**
  - every save disables all controls until it finishes;
  - errors show per card;
  - no `dangerouslySetInnerHTML`.

In `today/page.tsx`, call `useAiData()`. When `data?.emailClassification.active === false`, render a notice card above the first section: the title `Email sorting is paused`, the `reason` text, and a link `Open AI data settings` to `/settings#ai-data`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @oneon/contracts build && pnpm --filter @oneon/dashboard exec vitest run src/lib/ai-data-ui.test.ts && pnpm --filter @oneon/dashboard typecheck`
Expected: PASS. The dashboard has no component-test harness; the components are checked in the browser review.

- [ ] **Step 5: Full suite and commit**

```bash
git add packages/dashboard
git commit -m "feat(ai-boundary): add Settings → AI data with opt-in confirmation and a paused-sorting notice"
```

---

### Task 19: ADR-012, PRD and environment templates

**Files:**
- Create: `docs/adr/012-ai-data-boundary.md`
- Modify: `docs/PRD.md` (one functional requirement block and the tech table row)
- Modify: `.env.example`, `.env.template` (new variables), `docs/SETUP_ENV.md` (how to generate the key)

- [ ] **Step 1: Write ADR-012**

```markdown
# ADR-012: AI Data Boundary

## Status: Accepted

## Date: 2026-10-03

## Context

Oneon sent data to AI providers from four call sites with no checkpoint: any code that could build a prompt
could send anything to any configured provider, and shadow mode copied it to a second provider. Connecting
ImpressoRx pharmacies (Step B) would add customer credit, supplier prices and controlled-drug records.

## Decision

1. One Model Gateway in front of every model call. Provider clients accept only an `ApprovedModelCall`, which only
   the gateway creates; architecture tests enforce it.
2. Data classes D0–D4, declared per field in code; an unclassified field is never sent. D3 never goes to an external
   provider; D4 never goes anywhere.
3. The effective limit is the lowest of: the provider's platform limit (registry in code), an emergency override
   that can only lower, the person's or pharmacy's choice, and the purpose's limit. Every provider starts unreviewed:
   personal D2 at most, business D1. Personal data above D1 needs the person's explicit opt-in.
4. Identifiers can be replaced by turn-scoped placeholders, restored for the person only after the answer passes a
   check. The mapping lives in memory only.
5. The audit trail records each decision and the shape of what was released, with keyed (HMAC) fingerprints — never
   prompts, answers or data values. The tables are append-only through the application; this does not stop direct
   database access.
6. The boundary governs disclosure to AI providers, not Oneon's authorised internal use of data. Rules apply only
   in the gateway. An approved action's executor receives the authoritative data it needs through `resolve`, even
   when the model that proposed the action never saw that data. Placeholders are restored to real identifiers
   before any tool or action receives them.

## Consequences

- Email classification and the daily briefing pause until the person opts in to D2 for their email provider.
- Chat keeps working at D1 without earlier assistant replies in context.
- A scanner on free text is a backstop with false negatives. Prompt injection is mitigated, not prevented.
- "Personal" is defined by source, not content; business data in a personal inbox leaves on the person's opt-in.
- That an action's business facts come from `resolve`, not from the model's proposal, is a review convention until
  Step C adds a mechanism.

## References

- Spec: `docs/superpowers/specs/2026-10-03-ai-data-boundary-design.md`
- ADR-011: Action Spec framework (the action safety plane this complements)
```

- [ ] **Step 2: Update the PRD**

Add this functional requirement after the action requirements (FR-026…FR-034). The highest number in `docs/PRD.md` today is FR-071, so this is **FR-072**.

```markdown
| FR-072 | AI data boundary | Every model call passes the Model Gateway; fields carry declared classes D0–D4; the effective limit is the lowest of platform, override, person/pharmacy and purpose limits; personal D2 needs an explicit opt-in in Settings → AI data; the audit log stores decisions and released shape, never content. |
```

In the tech-stack table, add the row `| AI data boundary | Model Gateway (application/src/ai-boundary) — see ADR-012 |`.

- [ ] **Step 3: Update the environment templates**

In `.env.example` and `.env.template`, after the LLM variables:

```bash
# AI data boundary (ADR-012)
# Required when any model provider key is set. Generate with: openssl rand -base64 32
MODEL_AUDIT_HMAC_KEY=
# Bump when you rotate MODEL_AUDIT_HMAC_KEY
MODEL_AUDIT_HMAC_KEY_VERSION=1
# Emergency override: suspend a provider or lower its limit, e.g. deepseek:suspended,anthropic:D1
# MODEL_PROVIDER_OVERRIDES=
```

In `docs/SETUP_ENV.md`, under "Generating Secrets", add `MODEL_AUDIT_HMAC_KEY` to the `openssl rand -base64 32` list, with one line explaining it keys the AI audit fingerprints.

- [ ] **Step 4: Verify and commit**

Run: `pnpm -r run build && pnpm -r run typecheck && pnpm test`. Expected: green.

```bash
git add docs .env.example .env.template
git commit -m "docs(ai-boundary): add ADR-012, PRD requirement and environment variables"
```

**After this task (the person's own steps, not a code change):**
1. Add `MODEL_AUDIT_HMAC_KEY` to the root `.env` (`openssl rand -base64 32`), then restart the server.
2. Open Settings → AI data, check DeepSeek's current terms, then confirm the recorded decision or keep basic.
