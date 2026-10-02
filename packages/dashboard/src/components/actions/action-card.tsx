"use client";

import { useState } from "react";
import type { ActionView } from "@oneon/contracts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Zap } from "lucide-react";
import { GROUP_BADGE, actorLabel, evidenceSummary, operationLabel, statusLabel, undoNote, verifyingNote } from "@/lib/action-ui";

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
  const undoLine = undoNote(view);

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

        {undoLine && <p className="text-label-sm meta-copy">{undoLine}</p>}

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
