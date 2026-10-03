# Phase 5: Dashboard (Tasks 17–20)

Read first: spec §13 (UI) and §16 (browser review). Global constraints in [README.md](README.md) apply. Follow the dashboard's existing design system: `Card`, `Badge`, `Button` from `@/components/ui`, and the utility classes already used in `src/app/actions/page.tsx` (`page-eyebrow`, `page-title`, `page-copy`, `filter-chip`, `panel-eyebrow`, `state-*`, `meta-copy`, `rounded-eight`, motion classes). The dashboard has no component-test library; logic lives in pure helpers that are unit-tested, and the components stay thin.

---

### Task 17: UI helpers and the `info` badge

**Files:**
- Create: `packages/dashboard/src/lib/action-ui.ts`
- Test: `packages/dashboard/src/lib/action-ui.test.ts`
- Modify: `packages/dashboard/src/components/ui/badge.tsx` (add `info`)
- Modify: `packages/dashboard/src/lib/hooks.ts` (add `useLegacyActions`, `useActionDefinitions`)

**Interfaces:**
- Consumes: `STATUS_GROUPS`, `ActionView`, `ChatActionRef`, `StatusGroup` (`@oneon/contracts`).
- Produces: `GROUP_FILTERS`, `type ActionFilter = StatusGroup | "all" | "legacy"`, `GROUP_BADGE: Record<StatusGroup, BadgeVariant>`, `statusLabel(status)`, `actionsQuery(filter, offset, limit): string | null`, `evidenceSummary(item): { title: string; lines: string[] }`, `actorLabel(actor)`, `operationLabel(op)`, `chatChip(ref): { href: string; text: string }`, `verifyingNote(view): string | null`, `useLegacyActions(query)`, `useActionDefinitions()`.

- [ ] **Step 1: Write the failing helper tests**

```ts
// action-ui.test.ts
import { describe, it, expect } from "vitest";
import { STATUS_GROUPS } from "@oneon/contracts";
import {
  GROUP_BADGE, GROUP_FILTERS, actionsQuery, actorLabel, chatChip, evidenceSummary, operationLabel, statusLabel, verifyingNote,
} from "./action-ui";

describe("action UI helpers", () => {
  it("colours every group by one rule (spec §13.1)", () => {
    expect(GROUP_BADGE).toEqual({ needs_you: "warning", in_progress: "info", done: "success", problem: "error", closed: "default" });
    expect(GROUP_FILTERS.map((f) => f.label)).toEqual(["Needs you", "In progress", "Done", "Problem", "Closed", "All", "Legacy (MVP1)"]);
  });

  it("labels all 15 statuses", () => {
    for (const status of Object.values(STATUS_GROUPS).flat()) expect(statusLabel(status)).not.toBe(status);
    expect(statusLabel("rollback_failed")).toBe("Undo failed");
  });

  it("builds list queries; legacy uses its own endpoint", () => {
    expect(actionsQuery("needs_you", 0, 25)).toBe("limit=25&offset=0&group=needs_you");
    expect(actionsQuery("all", 25, 25)).toBe("limit=25&offset=25");
    expect(actionsQuery("legacy", 0, 25)).toBeNull();
  });

  it("summarises evidence by kind", () => {
    expect(evidenceSummary({ kind: "rule", source: "oneon:inbox-rules", asOf: "", data: { ruleId: "inbox.urgent_notify", condition: "priority <= 2", values: { priority: 1 } } })).toEqual({
      title: "Rule",
      lines: ["inbox.urgent_notify: priority <= 2", "priority = 1"],
    });
    expect(evidenceSummary({ kind: "chat_turn", source: "chat", asOf: "", data: { excerpt: "set up a call", model: "anthropic:claude" } })).toEqual({
      title: "Chat",
      lines: ['"set up a call"', "Model: anthropic:claude"],
    });
  });

  it("names actors and operations in plain words", () => {
    expect(actorLabel({ kind: "sweeper" })).toBe("Recovery");
    expect(actorLabel({ kind: "policy" })).toBe("Oneon policy");
    expect(operationLabel("retry")).toBe("Try again");
  });

  it("links chat chips to the action", () => {
    expect(chatChip({ id: "a1", actionType: "create_calendar_event", label: "Create calendar event", status: "awaiting_approval" })).toEqual({
      href: "/actions#action-a1",
      text: "Waiting for approval · Open",
    });
    expect(chatChip({ id: "a2", actionType: "x", label: "x", status: "completed" }).text).toBe("Done · Open");
  });

  it("explains an unconfirmed outcome", () => {
    expect(verifyingNote({ verifyingSince: "2026-10-01T12:00:00.000Z" } as never)).toMatch(/^Couldn't confirm yet; Oneon will check again automatically \(last checked /);
    expect(verifyingNote({ verifyingSince: null } as never)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/dashboard && npx vitest run src/lib/action-ui.test.ts`
Expected: FAIL, module missing.

- [ ] **Step 3: Write `action-ui.ts`**

```ts
import type { ActionView, ChatActionRef, StatusGroup } from "@oneon/contracts";

export type ActionFilter = StatusGroup | "all" | "legacy";
type BadgeVariant = "warning" | "info" | "success" | "error" | "default";

export const GROUP_FILTERS: Array<{ key: ActionFilter; label: string }> = [
  { key: "needs_you", label: "Needs you" },
  { key: "in_progress", label: "In progress" },
  { key: "done", label: "Done" },
  { key: "problem", label: "Problem" },
  { key: "closed", label: "Closed" },
  { key: "all", label: "All" },
  { key: "legacy", label: "Legacy (MVP1)" },
];

/** Spec §13.1: the group sets the colour. */
export const GROUP_BADGE: Record<StatusGroup, BadgeVariant> = {
  needs_you: "warning",
  in_progress: "info",
  done: "success",
  problem: "error",
  closed: "default",
};

const STATUS_LABELS: Record<string, string> = {
  proposed: "Proposed",
  validating: "Checking",
  awaiting_approval: "Needs approval",
  approved: "Approved",
  executing: "Running",
  verifying: "Confirming",
  completed: "Completed",
  partially_completed: "Partly done",
  rejected: "Rejected",
  expired: "Expired",
  cancelled: "Cancelled",
  failed: "Failed",
  rolling_back: "Undoing",
  rolled_back: "Undone",
  rollback_failed: "Undo failed",
};

export const statusLabel = (status: string): string => STATUS_LABELS[status] ?? status;

export function actionsQuery(filter: ActionFilter, offset: number, limit: number): string | null {
  if (filter === "legacy") return null;
  const parts = [`limit=${limit}`, `offset=${offset}`];
  if (filter !== "all") parts.push(`group=${filter}`);
  return parts.join("&");
}

const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

export function evidenceSummary(item: ActionView["evidence"][number]): { title: string; lines: string[] } {
  const d = item.data;
  switch (item.kind) {
    case "email":
      return { title: "Email", lines: [`From ${str(d.from)}`, str(d.subject)].filter(Boolean) };
    case "classification":
      return { title: "Classification", lines: [`${str(d.category)}, priority ${str(d.priority)}`, str(d.summary), `Model: ${str(d.model)}`].filter(Boolean) };
    case "deadline":
      return {
        title: "Deadline",
        lines: [str(d.description), `Due ${str(d.dueDate).slice(0, 10)}`, `Confidence ${Math.round(Number(d.confidence ?? 0) * 100)}%`],
      };
    case "chat_turn":
      return { title: "Chat", lines: [d.excerpt ? `"${str(d.excerpt)}"` : "(no excerpt)", `Model: ${str(d.model)}`] };
    case "rule": {
      const values = Object.entries((d.values as Record<string, unknown>) ?? {}).map(([k, v]) => `${k} = ${str(v)}`);
      return { title: "Rule", lines: [`${str(d.ruleId)}: ${str(d.condition)}`, ...values] };
    }
    case "legacy_action":
      return { title: "MVP1 proposal", lines: [`Created ${str(d.createdAt).slice(0, 10)}`] };
    case "retry_of":
      return { title: "Retry of", lines: [str(d.actionId)] };
    default:
      return { title: item.kind, lines: [JSON.stringify(d)] };
  }
}

export function actorLabel(actor: { kind: string }): string {
  return { user: "You", policy: "Oneon policy", system: "Oneon", sweeper: "Recovery" }[actor.kind] ?? actor.kind;
}

export function operationLabel(op: string): string {
  return { approve: "Approve", reject: "Reject", cancel: "Cancel", undo: "Undo", retry: "Try again" }[op] ?? op;
}

const CHIP_TEXT: Record<string, string> = { awaiting_approval: "Waiting for approval", completed: "Done" };

export function chatChip(ref: ChatActionRef): { href: string; text: string } {
  return { href: `/actions#action-${ref.id}`, text: `${CHIP_TEXT[ref.status] ?? statusLabel(ref.status)} · Open` };
}

export function verifyingNote(view: Pick<ActionView, "verifyingSince">): string | null {
  if (!view.verifyingSince) return null;
  const at = new Date(view.verifyingSince).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `Couldn't confirm yet; Oneon will check again automatically (last checked ${at}).`;
}
```

- [ ] **Step 4: Add the `info` badge and hooks**

In `badge.tsx`, add to the `variant` map:

```ts
        info:
          "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
```

In `hooks.ts`:

```ts
/** Legacy MVP1 actions (read-only) */
export function useLegacyActions(query: string | null, config?: SWRConfiguration) {
  return useSWR(query === null ? null : `/api/actions/legacy?${query}`, fetcher, config);
}

/** Settings → Actions */
export function useActionDefinitions(config?: SWRConfiguration) {
  return useSWR("/api/action-definitions", fetcher, config);
}
```

- [ ] **Step 5: Run tests, build, typecheck**

Run: `cd packages/dashboard && npx vitest run`
Expected: PASS.
Run: `pnpm -r run build && pnpm -r run typecheck && pnpm test`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/src
git commit -m "feat(dashboard): add action UI helpers and info badge" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 18: The Action Center

Spec §13.1. Replaces `src/app/actions/page.tsx`; removes the deprecated MVP1 contract schemas.

**Files:**
- Create: `packages/dashboard/src/components/actions/action-card.tsx`
- Create: `packages/dashboard/src/components/actions/legacy-list.tsx`
- Rewrite: `packages/dashboard/src/app/actions/page.tsx`
- Modify: `packages/contracts/src/actions.contract.ts` (delete the `@deprecated` exports)

**Interfaces:**
- Consumes: Task 17 helpers and hooks; `ActionView`, `ActionViewListResponse`, `LegacyActionListResponse`.
- Produces: `<ActionCard view onOperation busy highlighted />`, `<LegacyList query />`.

- [ ] **Step 1: Write `action-card.tsx`**

```tsx
"use client";

import { useState } from "react";
import type { ActionView } from "@oneon/contracts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Zap } from "lucide-react";
import { GROUP_BADGE, actorLabel, evidenceSummary, operationLabel, statusLabel, verifyingNote } from "@/lib/action-ui";

type Operation = ActionView["allowedOperations"][number];

export function ActionCard(props: {
  view: ActionView;
  busy: boolean;
  highlighted: boolean;
  onOperation: (op: Operation) => void;
}) {
  const { view, busy, highlighted, onOperation } = props;
  const [confirmingUndo, setConfirmingUndo] = useState(false);
  const note = verifyingNote(view);

  return (
    <Card id={`action-${view.id}`} className={highlighted ? "ring-1 ring-amber-500/45 dark:ring-amber-300/45" : ""}>
      <CardHeader>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="flex items-center gap-2">
            <Zap className="h-4 w-4" />
            {view.label}
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={GROUP_BADGE[view.group]}>{statusLabel(view.status)}</Badge>
            <Badge variant="default">Risk {view.risk}</Badge>
          </div>
        </div>
        <p className="text-label-sm meta-copy">
          {view.origin.label}
          {view.origin.excerpt ? ` · "${view.origin.excerpt}"` : ""}
        </p>
      </CardHeader>

      <CardContent className="space-y-3">
        <section className="rounded-eight bg-surface-low p-4 dark:bg-dark-surface-low">
          <p className="panel-eyebrow">What Oneon will do</p>
          <p className="text-sm text-on-surface dark:text-dark-on-surface">{view.description}</p>
          {note && <p className="mt-2 text-label-sm text-amber-800 dark:text-amber-300">{note}</p>}
        </section>

        {view.evidence.length > 0 && (
          <section className="rounded-eight border border-outline-variant/35 p-4 dark:border-dark-outline-variant/35">
            <p className="panel-eyebrow">Evidence</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {view.evidence.map((item, i) => {
                const s = evidenceSummary(item);
                return (
                  <div key={i}>
                    <p className="text-label-sm font-semibold text-on-surface dark:text-dark-on-surface">{s.title}</p>
                    {s.lines.map((line, j) => (
                      <p key={j} className="text-sm meta-copy">{line}</p>
                    ))}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {view.decision && (
          <section className="rounded-eight bg-surface-low p-4 dark:bg-dark-surface-low">
            <p className="panel-eyebrow">{view.decision.outcome === "auto" ? "Why it ran automatically" : view.decision.outcome === "refuse" ? "Why it was refused" : "Why it needs approval"}</p>
            {view.decision.reasons.map((r) => (
              <p key={r.code} className="text-sm text-on-surface dark:text-dark-on-surface">{r.text}</p>
            ))}
          </section>
        )}

        {view.checks.length > 0 && (
          <section className="rounded-eight border border-outline-variant/35 p-4 dark:border-dark-outline-variant/35">
            <p className="panel-eyebrow">Checks</p>
            <ul className="space-y-1">
              {view.checks.map((c) => (
                <li key={c.id} className="text-sm">
                  <span className={c.passed ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"}>{c.passed ? "Passed" : "Failed"}</span>{" "}
                  <span className="text-on-surface dark:text-dark-on-surface">{c.id.replace(/_/g, " ")}</span>
                  {!c.passed && c.expected !== undefined && (
                    <span className="meta-copy"> (expected {JSON.stringify(c.expected)}, got {JSON.stringify(c.actual ?? null)})</span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {view.error && (
          <section className="rounded-eight border border-red-500/20 bg-red-500/10 p-4 dark:border-red-400/25 dark:bg-red-500/15">
            <p className="panel-eyebrow text-red-700 dark:text-red-300">What went wrong</p>
            <p className="text-sm text-red-700/90 dark:text-red-200">{view.error.message}</p>
          </section>
        )}

        <p className="text-label-sm meta-copy">
          {view.undo.text}
          {view.attemptNumber > 1 ? ` · Attempt ${view.attemptNumber}` : ""}
        </p>

        <details className="rounded-eight bg-surface-low p-3 dark:bg-dark-surface-low">
          <summary className="cursor-pointer text-label-sm meta-copy">Timeline ({view.timeline.length})</summary>
          <ol className="mt-2 space-y-1">
            {view.timeline.map((e) => (
              <li key={e.seq} className="text-sm">
                <span className="meta-copy">{new Date(e.createdAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}</span>{" "}
                <span className="text-on-surface dark:text-dark-on-surface">{statusLabel(e.toStatus)}</span>{" "}
                <span className="meta-copy">· {actorLabel(e.actor)}</span>
              </li>
            ))}
          </ol>
        </details>

        {confirmingUndo ? (
          <div className="rounded-eight border border-amber-500/35 bg-amber-500/10 p-3 dark:border-amber-400/40 dark:bg-amber-500/15">
            <p className="text-sm text-amber-900 dark:text-amber-100">
              Undo this action?{view.undo.warning ? ` ${view.undo.warning}` : ""}
            </p>
            <div className="mt-2 flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => setConfirmingUndo(false)}>Keep it</Button>
              <Button size="sm" variant="primary" disabled={busy} onClick={() => { setConfirmingUndo(false); onOperation("undo"); }}>Undo</Button>
            </div>
          </div>
        ) : (
          view.allowedOperations.length > 0 && (
            <div className="flex flex-wrap justify-end gap-2">
              {view.allowedOperations.map((op) => (
                <Button
                  key={op}
                  size="sm"
                  variant={op === "approve" || op === "retry" ? "primary" : "secondary"}
                  disabled={busy}
                  onClick={() => (op === "undo" ? setConfirmingUndo(true) : onOperation(op))}
                >
                  {operationLabel(op)}
                </Button>
              ))}
            </div>
          )
        )}
      </CardContent>
    </Card>
  );
}
```

Buttons are drawn only from `view.allowedOperations` (the Plutonium rule): no disabled placeholders for operations policy does not allow.

- [ ] **Step 2: Write `legacy-list.tsx`**

```tsx
"use client";

import type { LegacyActionListResponse } from "@oneon/contracts";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useLegacyActions } from "@/lib/hooks";

export function LegacyList({ query }: { query: string }) {
  const { data, isLoading } = useLegacyActions(query);
  const response = data as LegacyActionListResponse | undefined;
  if (isLoading || !response) return <div className="state-skeleton h-24" />;
  return (
    <div className="space-y-3">
      <Card className="border-amber-500/35 bg-amber-500/10 dark:border-amber-400/40 dark:bg-amber-500/15">
        <CardContent className="py-3 text-label-sm text-amber-900 dark:text-amber-100">{response.banner}</CardContent>
      </Card>
      {response.actions.length === 0 ? (
        <p className="state-title">No MVP1 actions to show.</p>
      ) : (
        response.actions.map((a) => (
          <Card key={a.id}>
            <CardContent className="flex flex-col gap-1 py-4">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-on-surface dark:text-dark-on-surface">{a.actionType.replace(/_/g, " ")}</p>
                <Badge variant="default">{a.status.replace(/_/g, " ")} (MVP1)</Badge>
              </div>
              <p className="text-label-sm meta-copy">{new Date(a.createdAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}</p>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
```

- [ ] **Step 3: Rewrite the page**

`packages/dashboard/src/app/actions/page.tsx`:

```tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import type { ActionView, ActionViewListResponse } from "@oneon/contracts";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Zap } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useAction, useActions } from "@/lib/hooks";
import { GROUP_FILTERS, actionsQuery, type ActionFilter } from "@/lib/action-ui";
import { getMotionDelayClass } from "@/lib/motion-utils";
import { ActionCard } from "@/components/actions/action-card";
import { LegacyList } from "@/components/actions/legacy-list";

const LIMIT = 25;

export default function ActionsPage() {
  const [filter, setFilter] = useState<ActionFilter>("needs_you");
  const [offset, setOffset] = useState(0);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [opError, setOpError] = useState<string | null>(null);

  const query = actionsQuery(filter, offset, LIMIT);
  const { data, error, isLoading, mutate } = useActions(query ?? undefined, { isPaused: () => query === null });
  const { data: targetData, mutate: mutateTarget } = useAction(targetId);
  const response = data as ActionViewListResponse | undefined;
  const target = targetData as ActionView | undefined;

  useEffect(() => {
    const sync = () => {
      const hash = window.location.hash;
      setTargetId(hash.startsWith("#action-") ? hash.slice("#action-".length) || null : null);
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  const rendered = useMemo(() => {
    const list = response?.actions ?? [];
    if (!target || list.some((a) => a.id === target.id)) return list;
    return [target, ...list];
  }, [response, target]);

  const runOperation = async (id: string, op: ActionView["allowedOperations"][number]) => {
    setBusyId(id);
    setOpError(null);
    try {
      await apiFetch(`/api/actions/${id}/${op}`, { method: "POST" });
    } catch (err) {
      setOpError(err instanceof Error ? err.message : "That didn't work. Reload and try again.");
    } finally {
      setBusyId(null);
      await Promise.all([mutate(), mutateTarget()]);
    }
  };

  return (
    <div className="space-y-6 md:space-y-7 lg:space-y-8 motion-page-enter">
      <div className="space-y-2 motion-rise-in">
        <p className="page-eyebrow">Operational Hub</p>
        <h1 className="page-title">Action Center</h1>
        <p className="page-copy">Everything Oneon proposed, did, or was refused — with the evidence and checks behind it.</p>
      </div>

      <div className={`motion-rise-in-soft overflow-x-auto pb-1 ${getMotionDelayClass(1)}`}>
        <div className="flex gap-1">
          {GROUP_FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => { setFilter(f.key); setOffset(0); }}
              className={`filter-chip ${filter === f.key ? "filter-chip-active" : "filter-chip-idle"}`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {opError && (
        <Card className="border-red-500/20 bg-red-500/10 dark:border-red-400/25 dark:bg-red-500/15">
          <CardContent className="py-3 text-label-sm text-red-800 dark:text-red-200">{opError}</CardContent>
        </Card>
      )}

      {filter === "legacy" ? (
        <LegacyList query={`limit=${LIMIT}&offset=${offset}`} />
      ) : (
        <>
          {isLoading && <div className="state-skeleton h-24" />}
          {error && (
            <Card>
              <CardContent className="state-content state-content-center py-8">
                <AlertTriangle className="h-8 w-8 text-red-500/80 dark:text-red-400/80" />
                <p className="state-error">Failed to load actions.</p>
              </CardContent>
            </Card>
          )}
          {response && rendered.length === 0 && (
            <Card>
              <CardContent className="state-content state-content-center py-10">
                <Zap className="state-icon" />
                <p className="state-title">Nothing here.</p>
              </CardContent>
            </Card>
          )}
          <div className="space-y-3 md:space-y-4">
            {rendered.map((view) => (
              <ActionCard
                key={view.id}
                view={view}
                busy={busyId === view.id}
                highlighted={view.id === targetId}
                onOperation={(op) => runOperation(view.id, op)}
              />
            ))}
          </div>
          {response && (
            <div className="flex flex-col gap-3 pt-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-label-md meta-copy">
                Showing {response.pagination.total === 0 ? 0 : offset + 1}–{Math.min(offset + LIMIT, response.pagination.total)} of {response.pagination.total}
              </p>
              <div className="flex w-full gap-2 sm:w-auto">
                <Button variant="secondary" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - LIMIT))}>Previous</Button>
                <Button variant="secondary" size="sm" disabled={!response.pagination.hasMore} onClick={() => setOffset(offset + LIMIT)}>Next</Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
```

If `useActions` does not accept SWR's `isPaused`, change it to `useActions(query: string | null, …)` and pass `null` to skip the request, mirroring `useLegacyActions`.

- [ ] **Step 4: Remove the deprecated contract schemas**

Delete every export marked `@deprecated` in `packages/contracts/src/actions.contract.ts` (`ActionsQuerySchema`, `ActionItemResponseSchema`, `ActionResponseSchema`, `ActionsListResponseSchema` and their types, plus the local `ActionStatusEnum` / `ActionExecutionStatusEnum`). Run `grep -rn "ActionItemResponse\|ActionsListResponse\|ActionResponse\b\|ActionsQuerySchema" packages/*/src` — expected: no output.

- [ ] **Step 5: Build, typecheck, test, and look at it**

Run: `pnpm -r run build && pnpm -r run typecheck && pnpm test`
Expected: green.
Run the app (`pnpm dev:server` and `pnpm dev:dashboard` in two terminals), open `/actions`, and check: each filter loads; cards show every panel; only allowed buttons render; Legacy shows the banner; a `#action-<id>` link highlights the card. Fix anything visibly broken before committing.

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/src packages/contracts/src
git commit -m "feat(dashboard): rebuild the Action Center on the action framework" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 19: Settings → Actions

Spec §13.2.

**Files:**
- Create: `packages/dashboard/src/components/settings/actions-settings.tsx`
- Modify: `packages/dashboard/src/app/settings/page.tsx` (render it before "Notification Preferences")

**Interfaces:**
- Consumes: `useActionDefinitions`, `ActionDefinitionsResponse`, `ActionDefinitionView`, `apiFetch`.
- Produces: `<ActionsSettings />`.

- [ ] **Step 1: Write the component**

```tsx
"use client";

import { useState } from "react";
import type { ActionDefinitionView, ActionDefinitionsResponse } from "@oneon/contracts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { useActionDefinitions } from "@/lib/hooks";

export function ActionsSettings() {
  const { data, mutate } = useActionDefinitions();
  const response = data as ActionDefinitionsResponse | undefined;
  const [pendingOff, setPendingOff] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const save = async (def: ActionDefinitionView, body: { enabled?: boolean; approvalMode?: string }) => {
    setSaving(def.type);
    setErrors((e) => ({ ...e, [def.type]: "" }));
    try {
      await apiFetch(`/api/action-definitions/${def.type}/config`, { method: "PUT", body: JSON.stringify(body) });
      await mutate();
    } catch (err) {
      setErrors((e) => ({ ...e, [def.type]: err instanceof Error ? err.message : "Couldn't save. Try again." }));
    } finally {
      setSaving(null);
      setPendingOff(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Actions</CardTitle>
        <p className="text-label-sm meta-copy">What Oneon may do on its own, and what needs your approval. Options stricter than each action's minimum are the only ones shown.</p>
      </CardHeader>
      <CardContent>
        {!response ? (
          <div className="state-skeleton h-24" />
        ) : (
          <div className="space-y-2">
            {response.definitions.map((def) => (
              <div key={def.type} className="rounded-eight bg-surface-low p-3 dark:bg-dark-surface-low">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-semibold text-on-surface dark:text-dark-on-surface">{def.label}</p>
                    <p className="text-label-sm meta-copy">
                      Risk {def.risk.effective}
                      {def.risk.effective !== def.risk.floor ? ` (minimum ${def.risk.floor})` : ""} · Approval expires after {def.expiryHours} h
                      {def.lastChange ? ` · Last changed ${new Date(def.lastChange.changedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : ""}
                    </p>
                  </div>
                  {def.available ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="sr-only" htmlFor={`approval-${def.type}`}>Approval for {def.label}</label>
                      <select
                        id={`approval-${def.type}`}
                        className="rounded-eight border border-outline-variant/40 bg-surface-lowest px-2 py-1 text-sm dark:border-dark-outline-variant/40 dark:bg-dark-surface-lowest"
                        value={def.approval.mode}
                        disabled={saving === def.type}
                        onChange={(e) => save(def, { approvalMode: e.target.value })}
                      >
                        {def.approval.options.map((o) => (
                          <option key={o.mode} value={o.mode}>{o.label}</option>
                        ))}
                      </select>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={saving === def.type}
                        onClick={() => (def.enabled ? setPendingOff(def.type) : save(def, { enabled: true }))}
                      >
                        {def.enabled ? "Turn off" : "Turn on"}
                      </Button>
                    </div>
                  ) : (
                    <Badge variant="default">Unavailable: {def.unavailableReason}</Badge>
                  )}
                </div>

                {pendingOff === def.type && (
                  <div className="mt-2 rounded-eight border border-amber-500/35 bg-amber-500/10 p-3 text-sm text-amber-900 dark:border-amber-400/40 dark:bg-amber-500/15 dark:text-amber-100">
                    <p>Turn off {def.label}?{def.disableWarning ? ` ${def.disableWarning}` : ""}</p>
                    <div className="mt-2 flex gap-2">
                      <Button size="sm" variant="secondary" onClick={() => setPendingOff(null)}>Keep on</Button>
                      <Button size="sm" variant="primary" onClick={() => save(def, { enabled: false })}>Turn off</Button>
                    </div>
                  </div>
                )}

                {(def.flags.clamped.length > 0 || def.flags.rejected) && (
                  <p className="mt-2 text-label-sm text-amber-800 dark:text-amber-300">
                    {def.flags.rejected
                      ? "Your saved setting couldn't be read, so Oneon is using the default. Save a new value to fix it."
                      : "Your saved setting is looser than this action allows, so Oneon is using the minimum. Save a new value to clear this."}
                  </p>
                )}
                {errors[def.type] && <p className="mt-2 text-label-sm text-red-700 dark:text-red-300">{errors[def.type]}</p>}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: Render it**

In `settings/page.tsx`, import `{ ActionsSettings } from "@/components/settings/actions-settings"` and place `<ActionsSettings />` immediately before the `{/* Notification Preferences */}` card.

- [ ] **Step 3: Build, typecheck, test, and look at it**

Run: `pnpm -r run build && pnpm -r run typecheck && pnpm test`
Expected: green.
In the running app, open `/settings` and check: `create_reminder` offers Auto / Always ask; the calendar rows offer "Auto unless other people involved" / "Always ask" and no plain Auto; `send` shows "Unavailable: needs Gmail send access (gmail.send)"; turning off `notify` shows its warning before saving; after a save the row shows the change line.

- [ ] **Step 4: Commit**

```bash
git add packages/dashboard/src
git commit -m "feat(dashboard): add Settings → Actions" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 20: Chat chips, Today link, and the browser review

Spec §13.3 and §16.

**Files:**
- Modify: `packages/dashboard/src/app/chat/page.tsx`
- Modify: `packages/dashboard/src/app/today/page.tsx` (pending-actions link)

- [ ] **Step 1: Show action chips under chat replies**

In `chat/page.tsx`:
- add `actions?: ChatActionRef[]` to the local `ChatMessage` interface and `actions?: ChatActionRef[]` to the local `ChatResponse` interface (import `ChatActionRef` from `@oneon/contracts`);
- when appending the assistant message, include `actions: result.actions ?? []`;
- inside the assistant bubble, after the `<p>` that renders `msg.content`, add:

```tsx
                {msg.role === "assistant" && msg.actions && msg.actions.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {msg.actions.map((ref) => {
                      const chip = chatChip(ref);
                      return (
                        <a
                          key={ref.id}
                          href={chip.href}
                          className="motion-interactive inline-flex items-center gap-1 rounded-six border border-outline-variant/40 px-2 py-1 text-label-sm text-on-surface dark:border-dark-outline-variant/40 dark:text-dark-on-surface"
                        >
                          {ref.label}: {chip.text}
                        </a>
                      );
                    })}
                  </div>
                )}
```

  with `import { chatChip } from "@/lib/action-ui";`.

- [ ] **Step 2: Point Today's pending card at "Needs you"**

In `today/page.tsx`, keep the existing link target `/actions` (the Action Center opens on "Needs you" by default) and change the card label "Pending Actions" to "Needs your approval". No other change.

- [ ] **Step 3: Build, typecheck, test**

Run: `pnpm -r run build && pnpm -r run typecheck && pnpm test`
Expected: green. Record the final test count.

- [ ] **Step 4: Prepare the browser review**

The review needs a test calendar, because scenarios 3–6 create, edit and delete events. In `.env` (repo root), set `CALENDAR_ID` to a dedicated test Google Calendar's ID. Start the server and dashboard, sign in, and walk through spec §16 yourself once, writing down any failure:

| # | Do | Expect |
|---|---|---|
| 1 | a spam email arrives | `archive` in Closed: rejected, "needs Gmail modify access (gmail.modify)" |
| 2 | an urgent email (priority ≤ 2) arrives | `notify` completed; exactly one notification under the bell |
| 3a | an email with a deadline arrives → Approve | `create_reminder` completed; event in the test calendar |
| 3b | Undo it | rolled back; event gone |
| 4 | chat: "focus block tomorrow 9–11" | runs automatically → completed; chip says done |
| 5 | chat: "invite ama@… to a call Friday 3pm" | Needs you, with "Google will email the invitation to ama@…"; chip says waiting |
| 6 | edit a reminder event in Calendar, then Undo | Problem: rollback failed, "changed since" |
| 7 | Settings → Actions | reminders can switch to Auto; calendar rows offer no plain Auto; `send` read-only; change appears; turning off `notify` warns |
| 8 | Legacy filter | old rows, banner, no buttons |
| 9 | any action | timeline shows every transition |

Fix anything that fails (with a test where the fix is logic), then hand the running app to the product owner for their review.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src
git commit -m "feat(dashboard): show action chips in chat and relabel Today's approvals" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
