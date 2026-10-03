# Phase 3 — Provider clients and tool output schemas

New provider clients that accept only an `ApprovedModelCall`, and a declared output schema for every chat tool. The old adapters stay until Task 16. Spec sections: §5.5, §10.1, §12 (tool output contracts).

---

### Task 10: Provider clients

**Files:**
- Create: `packages/infrastructure/src/llm/providers/deepseek-provider.ts`
- Create: `packages/infrastructure/src/llm/providers/anthropic-provider.ts`
- Create: `packages/infrastructure/src/llm/providers/index.ts`
- Modify: `packages/infrastructure/src/llm/index.ts` (add `export * from "./providers/index.js";`)
- Test: `packages/infrastructure/src/llm/providers/deepseek-provider.test.ts`, `anthropic-provider.test.ts`

**Interfaces:**
- Consumes: `ApprovedModelCall`, `ModelProvider`, `ProviderCompletion`, `ProviderError` (Task 1); the existing `DeepSeekHttpClient`, `DeepSeekRateLimitError`, `DeepSeekEmptyResponseError`, `DeepSeekApiError` and `CircuitBreaker`.
- Produces:
  - `DeepSeekProvider implements ModelProvider`, constructed with `{ apiKey: string; baseUrl?: string; circuitBreaker: { failureThreshold: number; resetTimeoutMs: number }; logger: Logger; client?: Pick<DeepSeekHttpClient, "chatCompletion"> }`
  - `AnthropicProvider implements ModelProvider`, constructed with `{ apiKey: string; circuitBreaker: { failureThreshold: number; resetTimeoutMs: number }; logger: Logger; client?: { messages: { create(body: unknown, options: { signal: AbortSignal }): Promise<{ content: Array<{ type: string; text?: string }>; usage?: { input_tokens: number; output_tokens: number } }> } } }`

Error mapping, for both providers (it decides whether the gateway retries):

| Failure | `ProviderError.retryable` |
|---|---|
| Rate limit (429) or authentication (401/403) | false |
| Empty response | true |
| Timeout (abort) | true |
| HTTP 5xx | true |
| Open circuit breaker | false |
| Anything else | false |

- [ ] **Step 1: Write the failing tests**

`deepseek-provider.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { ApprovedModelCall, ProviderError } from "@oneon/application";
import { DeepSeekProvider } from "./deepseek-provider.js";
import { DeepSeekApiError, DeepSeekEmptyResponseError, DeepSeekRateLimitError } from "../deepseek-http-client.js";

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const call = (json: boolean) =>
  ApprovedModelCall.mint({ callId: "c1", provider: "deepseek", model: "deepseek-v4-flash", system: "SYS", user: "USER", json, maxTokens: 1024, timeoutMs: 5000 });
const make = (chatCompletion: ReturnType<typeof vi.fn>) =>
  new DeepSeekProvider({ apiKey: "k", circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 1000 }, logger, client: { chatCompletion } });

describe("DeepSeekProvider", () => {
  it("sends exactly the approved system and user text, with JSON mode when asked", async () => {
    const chatCompletion = vi.fn().mockResolvedValue('{"ok":true}');
    await expect(make(chatCompletion).complete(call(true))).resolves.toEqual({ text: '{"ok":true}' });
    expect(chatCompletion.mock.calls[0][0]).toEqual({
      model: "deepseek-v4-flash",
      messages: [
        { role: "system", content: "SYS" },
        { role: "user", content: "USER" },
      ],
      max_tokens: 1024,
      response_format: { type: "json_object" },
    });
  });
  it("omits JSON mode for text output", async () => {
    const chatCompletion = vi.fn().mockResolvedValue("hello");
    await make(chatCompletion).complete(call(false));
    expect(chatCompletion.mock.calls[0][0]).not.toHaveProperty("response_format");
  });
  it.each([
    [new DeepSeekRateLimitError(), false],
    [new DeepSeekEmptyResponseError(), true],
    [new DeepSeekApiError("server error", 503), true],
    [new DeepSeekApiError("bad request", 400), false],
    [Object.assign(new Error("aborted"), { name: "AbortError" }), true],
  ])("maps %s to retryable=%s", async (error, retryable) => {
    const chatCompletion = vi.fn().mockRejectedValue(error);
    const failure = await make(chatCompletion).complete(call(true)).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).retryable).toBe(retryable);
  });
});
```

`anthropic-provider.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { ApprovedModelCall, ProviderError } from "@oneon/application";
import { AnthropicProvider } from "./anthropic-provider.js";

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const call = ApprovedModelCall.mint({ callId: "c1", provider: "anthropic", model: "claude-x", system: "SYS", user: "USER", json: true, maxTokens: 512, timeoutMs: 5000 });
const make = (create: ReturnType<typeof vi.fn>) =>
  new AnthropicProvider({ apiKey: "k", circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 1000 }, logger, client: { messages: { create } } });

describe("AnthropicProvider", () => {
  it("sends the approved text and returns the text block with token usage", async () => {
    const create = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "hi" }], usage: { input_tokens: 10, output_tokens: 2 } });
    await expect(make(create).complete(call)).resolves.toEqual({ text: "hi", inputTokens: 10, outputTokens: 2 });
    expect(create.mock.calls[0][0]).toEqual({ model: "claude-x", max_tokens: 512, system: "SYS", messages: [{ role: "user", content: "USER" }] });
  });
  it("treats a response without text as a retryable failure", async () => {
    const failure = await make(vi.fn().mockResolvedValue({ content: [] })).complete(call).catch((e: unknown) => e);
    expect(failure).toMatchObject({ retryable: true });
    expect(failure).toBeInstanceOf(ProviderError);
  });
  it.each([
    [{ status: 429 }, false],
    [{ status: 401 }, false],
    [{ status: 529 }, true],
  ])("maps HTTP %o to retryable=%s", async (shape, retryable) => {
    const failure = await make(vi.fn().mockRejectedValue(Object.assign(new Error("x"), shape))).complete(call).catch((e: unknown) => e);
    expect((failure as ProviderError).retryable).toBe(retryable);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @oneon/infrastructure exec vitest run src/llm/providers`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

`deepseek-provider.ts`:

```ts
import type { Logger } from "@oneon/domain";
import { ProviderError, type ApprovedModelCall, type ModelProvider, type ProviderCompletion } from "@oneon/application";
import { CircuitBreaker } from "../circuit-breaker.js";
import { DeepSeekApiError, DeepSeekEmptyResponseError, DeepSeekHttpClient, DeepSeekRateLimitError, type DeepSeekRequest } from "../deepseek-http-client.js";

export interface DeepSeekProviderConfig {
  apiKey: string;
  baseUrl?: string;
  circuitBreaker: { failureThreshold: number; resetTimeoutMs: number };
  logger: Logger;
  client?: Pick<DeepSeekHttpClient, "chatCompletion">;
}

export class DeepSeekProvider implements ModelProvider {
  readonly id = "deepseek" as const;
  private readonly client: Pick<DeepSeekHttpClient, "chatCompletion">;
  private readonly breaker: CircuitBreaker;

  constructor(config: DeepSeekProviderConfig) {
    this.client = config.client ?? new DeepSeekHttpClient(config.apiKey, config.baseUrl);
    this.breaker = new CircuitBreaker({ ...config.circuitBreaker, logger: config.logger });
  }

  async complete(call: ApprovedModelCall): Promise<ProviderCompletion> {
    const body: DeepSeekRequest = {
      model: call.model,
      messages: [
        { role: "system", content: call.system },
        { role: "user", content: call.user },
      ],
      max_tokens: call.maxTokens,
      ...(call.json ? { response_format: { type: "json_object" } } : {}),
    };
    try {
      const text = await this.breaker.execute(async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), call.timeoutMs);
        try {
          return await this.client.chatCompletion(body, controller.signal);
        } finally {
          clearTimeout(timer);
        }
      });
      return { text };
    } catch (error) {
      throw toProviderError(error);
    }
  }
}

function toProviderError(error: unknown): ProviderError {
  if (error instanceof DeepSeekRateLimitError) return new ProviderError("DeepSeek rate limit", false);
  if (error instanceof DeepSeekEmptyResponseError) return new ProviderError("DeepSeek returned an empty response", true);
  if (error instanceof DeepSeekApiError) return new ProviderError(`DeepSeek API error ${error.status}`, error.status >= 500);
  if (error instanceof Error && error.name === "AbortError") return new ProviderError("DeepSeek request timed out", true);
  return new ProviderError(error instanceof Error ? error.message : String(error), false);
}
```

If `DeepSeekApiError` does not expose `status` publicly, make it `readonly status: number` in `deepseek-http-client.ts`. That is the only change to that file.

`anthropic-provider.ts`:

```ts
import Anthropic from "@anthropic-ai/sdk";
import type { Logger } from "@oneon/domain";
import { ProviderError, type ApprovedModelCall, type ModelProvider, type ProviderCompletion } from "@oneon/application";
import { CircuitBreaker } from "../circuit-breaker.js";

type MessagesClient = {
  messages: {
    create(
      body: unknown,
      options: { signal: AbortSignal },
    ): Promise<{ content: Array<{ type: string; text?: string }>; usage?: { input_tokens: number; output_tokens: number } }>;
  };
};

export interface AnthropicProviderConfig {
  apiKey: string;
  circuitBreaker: { failureThreshold: number; resetTimeoutMs: number };
  logger: Logger;
  client?: MessagesClient;
}

export class AnthropicProvider implements ModelProvider {
  readonly id = "anthropic" as const;
  private readonly client: MessagesClient;
  private readonly breaker: CircuitBreaker;

  constructor(config: AnthropicProviderConfig) {
    this.client = config.client ?? (new Anthropic({ apiKey: config.apiKey }) as unknown as MessagesClient);
    this.breaker = new CircuitBreaker({ ...config.circuitBreaker, logger: config.logger });
  }

  async complete(call: ApprovedModelCall): Promise<ProviderCompletion> {
    try {
      return await this.breaker.execute(async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), call.timeoutMs);
        try {
          const response = await this.client.messages.create(
            { model: call.model, max_tokens: call.maxTokens, system: call.system, messages: [{ role: "user", content: call.user }] },
            { signal: controller.signal },
          );
          const block = response.content.find((b) => b.type === "text");
          if (!block?.text) throw new ProviderError("Anthropic returned no text", true);
          return { text: block.text, inputTokens: response.usage?.input_tokens, outputTokens: response.usage?.output_tokens };
        } finally {
          clearTimeout(timer);
        }
      });
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      const status = (error as { status?: number }).status;
      if (typeof status === "number") throw new ProviderError(`Anthropic API error ${status}`, status >= 500);
      if (error instanceof Error && error.name === "AbortError") throw new ProviderError("Anthropic request timed out", true);
      throw new ProviderError(error instanceof Error ? error.message : String(error), false);
    }
  }
}
```

`providers/index.ts`:

```ts
export * from "./deepseek-provider.js";
export * from "./anthropic-provider.js";
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @oneon/application build && pnpm --filter @oneon/infrastructure exec vitest run src/llm/providers`
Expected: PASS (12 tests).

- [ ] **Step 5: Full suite and commit**

```bash
git add packages/infrastructure/src/llm
git commit -m "feat(ai-boundary): add DeepSeek and Anthropic clients that accept only approved calls"
```

---

### Task 11: Tool output schemas and contract tests

Spec §10.1, §12. Every chat tool declares the fields it returns, with their classes. Undeclared fields reach the gateway as unclassified and are withheld with an alert (rule F2).

**Files:**
- Create: `packages/application/src/tools/output-schema.ts`
- Create: `packages/application/src/tools/__tests__/output-contract.ts`
- Modify: `packages/application/src/tools/tool-registry.ts` (`ToolDefinition` gains `output: ToolOutputSchema`)
- Modify: every tool listed in the table below (add `output: …` to its definition)
- Modify: `packages/application/src/actions/chat-action-tools.ts` (both tools get `output`)
- Modify: each listed tool's existing `*.test.ts` (one contract assertion on a real result), and any test that builds a `ToolDefinition` literal (add `output: { fields: {}, summaryClass: "D1" }`)
- Test: `packages/application/src/tools/output-schema.test.ts`

**Interfaces:**
- Consumes: `DataClass`, `ClassifiedRow`, `PromptPart` (Task 1).
- Produces:
  - `ToolFieldSpec { class: DataClass; freeText?: boolean; entity?: "person" | "customer" | "supplier" }`
  - `ToolOutputSchema { fields: Record<string, ToolFieldSpec>; summaryClass: DataClass; rowsFrom?: string; rowClass?: (row: Record<string, unknown>) => DataClass | undefined }`
  - `toolResultToRecord(tool: string, schema: ToolOutputSchema, result: { data: unknown; summary: string }): Extract<PromptPart, { kind: "record" }>`. The source is `tool:<name>`. A final row holds `summary`.
  - `EMAIL_ENTRY_FIELDS`, `CALENDAR_EVENT_FIELDS`, `TRANSACTION_FIELDS` (shared field maps)
  - Test helper `expectMatchesOutputSchema(tool: ToolDefinition, result: ToolResult)`

**Classes per tool.** Free text is D2 and `free`. A person or business identifier is D2 and an entity. Counts, timestamps, ids, enums and statuses are D1. Summaries are D1 when they hold only counts, dates and the user's own query; summaries carrying amounts or generated text are D2.

| Tool | Fields | `summaryClass` |
|---|---|---|
| `list_inbox`, `search_emails`, `list_urgent_items`, `list_follow_ups` | `EMAIL_ENTRY_FIELDS`: id D1, subject D2 free, from D2 entity person, source D1, receivedAt D1, category D1, priority D1, summary D2 free | D1 |
| `list_deadlines` | id, userId, inboundItemId, dueDate, confidence, status, createdAt, updatedAt D1; description D2 free | D1 |
| `list_calendar_events`, `search_calendar` | `CALENDAR_EVENT_FIELDS`: id, start, end, allDay, etag, updated D1; title D2 free; description D2 free; attendees D2; location D2 | D1 |
| `list_notifications` | `rowsFrom: "notifications"`; id, userId, eventType, deepLink, read, createdAt D1; title D2 free; body D2 free; unreadCount D1 | D1 |
| `list_pending_actions` | id, actionType, label, status, createdAt D1; description D2 free | D1 |
| `list_github_notifications` | id, reason, repository, updatedAt, unread D1; subject D2 | D1 |
| `list_github_prs` | id, number, state, repo, url, createdAt, updatedAt D1; title D2 free; author D2 entity person | D1 |
| `search_teams_messages` | id, channelName, createdAt D1; from D2 entity person; subject D2 free; bodyPreview D2 free | D1 |
| `search_personal_memory` | id, source, score, createdAt D1; title D2 free; snippet D2 free; metadata D2 | D1 |
| `search_finance_transactions`, `top_finance_transactions` | `TRANSACTION_FIELDS`: id, statementId, userId, postedAt, dedupeKey, createdAt D1; description D2 free; amountMinor D2; balanceMinor D2 | D1 |
| `summarize_finance_spend` | category D1, transactionCount D1, amountMinor D2 | D2 |
| `finance_spend_insights` | userId D1, period D1, summary D2, topCategories D2, anomalies D2 | D2 |
| `finance_statement_status` | userId D1, counts D1, recent D2 | D1 |
| `daily_briefing` | date D1, pendingActions D1, urgentItems D2, deadlines D2, calendar D2 | D2 |
| `create_calendar_event`, `update_calendar_event` | action D1 | D2 |

Before writing each schema, open the tool and confirm its real keys match the table. If a key differs, follow the code and note it in your report.

- [ ] **Step 1: Write the failing tests**

`output-schema.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { EMAIL_ENTRY_FIELDS, toolResultToRecord, type ToolOutputSchema } from "./output-schema.js";
import { decide } from "../ai-boundary/decide.js";
import { PROVIDER_REGISTRY } from "../ai-boundary/providers.js";

const inbox: ToolOutputSchema = { fields: EMAIL_ENTRY_FIELDS, summaryClass: "D1" };
const entry = { id: "i1", subject: "Invoice", from: "ama@x.com", source: "gmail", receivedAt: "2026-10-03T09:00:00Z", category: "work", priority: 2, summary: "Pay soon" };

describe("toolResultToRecord", () => {
  it("turns a list into classified rows plus a summary row", () => {
    const part = toolResultToRecord("list_inbox", inbox, { data: [entry], summary: "Found 1 inbox item." });
    expect(part.source).toBe("tool:list_inbox");
    expect(part.rows).toHaveLength(2);
    expect(part.rows[0].fields.find((f) => f.name === "from")).toEqual({ name: "from", class: "D2", value: "ama@x.com", entity: { type: "person", id: "ama@x.com" } });
    expect(part.rows[1].fields).toEqual([{ name: "summary", class: "D1", value: "Found 1 inbox item." }]);
  });

  it("marks an undeclared field unclassified, so the gateway withholds it with an alert and still answers (Review Focus 3)", () => {
    const part = toolResultToRecord("list_inbox", inbox, { data: [{ ...entry, bcc: "boss@x.com" }], summary: "s" });
    expect(part.rows[0].fields.find((f) => f.name === "bcc")?.class).toBeNull();
    const d = decide({
      context: { kind: "personal", identityId: "u1" },
      provider: { entry: PROVIDER_REGISTRY.deepseek },
      choiceLimit: "D2",
      request: { purpose: "chat_reply", output: "json", parts: [{ kind: "user_message", text: "inbox?" }, part] },
    });
    expect(d.kind).toBe("allow");
    expect(d.alert).toBe(true);
    expect(d.withheld).toContainEqual({ part: "record:tool:list_inbox", row: 0, field: "bcc", reason: "unclassified" });
  });

  it("reads rows from a nested list and puts the remaining keys in one extra row", () => {
    const schema: ToolOutputSchema = { fields: { id: { class: "D1" }, title: { class: "D2", freeText: true }, unreadCount: { class: "D1" } }, summaryClass: "D1", rowsFrom: "notifications" };
    const part = toolResultToRecord("list_notifications", schema, { data: { notifications: [{ id: "n1", title: "t" }], unreadCount: 3 }, summary: "s" });
    expect(part.rows.map((r) => r.fields.map((f) => f.name))).toEqual([["id", "title"], ["unreadCount"], ["summary"]]);
  });

  it("applies a declared row class", () => {
    const schema: ToolOutputSchema = { fields: { name: { class: "D2", entity: "customer" }, type: { class: "D1" } }, summaryClass: "D1", rowClass: (r) => (r.type === "Individual" ? "D3" : undefined) };
    const part = toolResultToRecord("receivables", schema, { data: [{ name: "Kofi", type: "Individual" }, { name: "ABC", type: "Hospital" }], summary: "s" });
    expect(part.rows[0].rowClass).toBe("D3");
    expect(part.rows[1].rowClass).toBeUndefined();
  });

  it("handles a null result as no rows besides the summary", () => {
    expect(toolResultToRecord("create_calendar_event", { fields: { action: { class: "D1" } }, summaryClass: "D2" }, { data: null, summary: "Not created" }).rows).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @oneon/application exec vitest run src/tools/output-schema.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement the schema module and the contract helper**

`output-schema.ts`:

```ts
import type { ClassifiedField, ClassifiedRow, DataClass, PromptPart } from "../ai-boundary/types.js";

export interface ToolFieldSpec {
  class: DataClass;
  freeText?: boolean;
  entity?: "person" | "customer" | "supplier";
}

export interface ToolOutputSchema {
  fields: Record<string, ToolFieldSpec>;
  summaryClass: DataClass;
  /** When data is an object holding the list, the key of that list; the other top-level keys form one extra row. */
  rowsFrom?: string;
  rowClass?: (row: Record<string, unknown>) => DataClass | undefined;
}

const D1: ToolFieldSpec = { class: "D1" };
const D2: ToolFieldSpec = { class: "D2" };
const FREE: ToolFieldSpec = { class: "D2", freeText: true };

export const EMAIL_ENTRY_FIELDS: Record<string, ToolFieldSpec> = {
  id: D1, subject: FREE, from: { class: "D2", entity: "person" }, source: D1, receivedAt: D1, category: D1, priority: D1, summary: FREE,
};
export const CALENDAR_EVENT_FIELDS: Record<string, ToolFieldSpec> = {
  id: D1, start: D1, end: D1, allDay: D1, etag: D1, updated: D1, title: FREE, description: FREE, attendees: D2, location: D2,
};
export const TRANSACTION_FIELDS: Record<string, ToolFieldSpec> = {
  id: D1, statementId: D1, userId: D1, postedAt: D1, dedupeKey: D1, createdAt: D1, description: FREE, amountMinor: D2, balanceMinor: D2,
};

function toRow(item: unknown, schema: ToolOutputSchema): ClassifiedRow {
  const obj = item !== null && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : { value: item };
  const fields: ClassifiedField[] = Object.entries(obj).map(([name, value]) => {
    const spec = schema.fields[name];
    if (!spec) return { name, class: null, value };
    return {
      name,
      class: spec.class,
      value,
      ...(spec.freeText ? { freeText: true } : {}),
      ...(spec.entity && typeof value === "string" ? { entity: { type: spec.entity, id: value } } : {}),
    };
  });
  const rowClass = schema.rowClass?.(obj);
  return rowClass ? { rowClass, fields } : { fields };
}

export function toolResultToRecord(
  tool: string,
  schema: ToolOutputSchema,
  result: { data: unknown; summary: string },
): Extract<PromptPart, { kind: "record" }> {
  const rows: ClassifiedRow[] = [];
  const data = result.data;
  if (Array.isArray(data)) rows.push(...data.map((item) => toRow(item, schema)));
  else if (data !== null && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (schema.rowsFrom && Array.isArray(obj[schema.rowsFrom])) {
      rows.push(...(obj[schema.rowsFrom] as unknown[]).map((item) => toRow(item, schema)));
      const rest = Object.fromEntries(Object.entries(obj).filter(([k]) => k !== schema.rowsFrom));
      if (Object.keys(rest).length > 0) rows.push(toRow(rest, schema));
    } else rows.push(toRow(obj, schema));
  }
  rows.push({ fields: [{ name: "summary", class: schema.summaryClass, value: result.summary }] });
  return { kind: "record", source: `tool:${tool}`, rows };
}
```

`__tests__/output-contract.ts`:

```ts
import { expect } from "vitest";
import type { ToolDefinition, ToolResult } from "../tool-registry.js";
import { toolResultToRecord } from "../output-schema.js";

/** Spec §12: a tool's real output must contain only declared fields, with entity and free-text values as strings. */
export function expectMatchesOutputSchema(tool: ToolDefinition, result: ToolResult): void {
  const record = toolResultToRecord(tool.name, tool.output, result);
  for (const row of record.rows) {
    for (const f of row.fields) {
      expect(f.class, `${tool.name}.${f.name} is not declared in its output schema`).not.toBeNull();
      if (f.entity) expect(typeof f.value, `${tool.name}.${f.name} is an entity and must be a string`).toBe("string");
      if (f.freeText && f.value !== null) expect(typeof f.value, `${tool.name}.${f.name} is free text and must be a string`).toBe("string");
    }
  }
}
```

In `tool-registry.ts`, add `output: ToolOutputSchema;` to `ToolDefinition`, importing the type from `./output-schema.js`.

- [ ] **Step 4: Declare every tool and add one contract assertion per tool**

For each tool in the table, add the `output` property to its returned definition. Example for `list-inbox.ts`:

```ts
import { EMAIL_ENTRY_FIELDS } from "./output-schema.js";
// inside the returned definition:
output: { fields: EMAIL_ENTRY_FIELDS, summaryClass: "D1" },
```

Example for `list-notifications.ts`:

```ts
output: {
  rowsFrom: "notifications",
  fields: {
    id: { class: "D1" }, userId: { class: "D1" }, eventType: { class: "D1" }, deepLink: { class: "D1" }, read: { class: "D1" }, createdAt: { class: "D1" },
    title: { class: "D2", freeText: true }, body: { class: "D2", freeText: true }, unreadCount: { class: "D1" },
  },
  summaryClass: "D1",
},
```

In each tool's existing test file, take the first test that calls `execute` and produces a non-empty result. After its existing assertions, add:

```ts
import { expectMatchesOutputSchema } from "./__tests__/output-contract.js";
// …
expectMatchesOutputSchema(tool, result);
```

Then make `tsc` pass everywhere: run `pnpm -r run build`, and add `output: { fields: {}, summaryClass: "D1" }` to every test-only `ToolDefinition` literal it flags (for example in `tool-registry.test.ts`, `run-intent-loop.test.ts` and agent-server route tests).

- [ ] **Step 5: Run to verify everything passes**

Run: `pnpm --filter @oneon/application exec vitest run src/tools src/actions/chat-action-tools.test.ts`
Expected: PASS. Every tool's contract assertion passes against its real output.

- [ ] **Step 6: Full suite and commit**

```bash
git add packages/application packages/agent-server
git commit -m "feat(ai-boundary): declare classified output schemas for every chat tool"
```
