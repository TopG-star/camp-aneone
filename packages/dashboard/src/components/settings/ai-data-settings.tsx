"use client";

import { useState } from "react";
import type { AiDataView } from "@oneon/contracts";
import { AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { useAiData } from "@/lib/hooks";
import { callLabel, classLabel, pendingDecisionText, purposeLabel } from "@/lib/ai-data-ui";

export function AiDataSettings() {
  const { data, error, mutate } = useAiData();
  const view = data as AiDataView | undefined;
  // One save at a time: every control is disabled while any save runs.
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  const save = async (provider: string, maxClass: "D1" | "D2") => {
    setSaving(true);
    setSaveError("");
    try {
      await apiFetch(
        "/api/ai-data/choices",
        { method: "POST", body: JSON.stringify({ provider, maxClass }) },
        { redirectOnAuth: false },
      );
      await mutate();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Couldn't save. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const pending = view?.pendingDecision ?? null;
  const pendingLabel = pending ? (view?.providers.find((p) => p.id === pending.provider)?.label ?? pending.provider) : "";

  return (
    <Card id="ai-data">
      <CardHeader>
        <CardTitle>AI data</CardTitle>
        <p className="text-label-sm meta-copy">What Oneon may send to AI providers about you. Business data follows your pharmacy&apos;s settings.</p>
      </CardHeader>
      <CardContent>
        {!view && error ? (
          <div className="state-content state-content-center py-8">
            <AlertTriangle className="h-8 w-8 text-red-500/80 dark:text-red-400/80" />
            <p className="state-error">Couldn&apos;t load AI data settings.</p>
          </div>
        ) : !view ? (
          <div className="state-skeleton h-24" />
        ) : (
          <div className="space-y-3">
            {pending && (
              <div className="rounded-eight border border-amber-500/35 bg-amber-500/10 p-3 text-sm text-amber-900 dark:border-amber-400/40 dark:bg-amber-500/15 dark:text-amber-100">
                <p>{pendingDecisionText(pending, pendingLabel)}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" variant="primary" disabled={saving} onClick={() => save(pending.provider, "D2")}>Confirm: include names and content</Button>
                  <Button size="sm" variant="secondary" disabled={saving} onClick={() => save(pending.provider, "D1")}>Keep basic</Button>
                </div>
              </div>
            )}

            <div className="space-y-2">
              {view.providers.filter((p) => p.configured).map((p) => (
                <div key={p.id} className="rounded-eight bg-surface-low p-3 dark:bg-dark-surface-low">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold text-on-surface dark:text-dark-on-surface">{p.label}</p>
                      {p.review === "unreviewed" && <Badge variant="warning">Unreviewed</Badge>}
                      {p.override === "suspended" && <Badge variant="error">Suspended</Badge>}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="sr-only" htmlFor={`ai-data-class-${p.id}`}>Personal data level for {p.label}</label>
                      <select
                        id={`ai-data-class-${p.id}`}
                        className="rounded-eight border border-outline-variant/40 bg-surface-lowest px-2 py-1 text-sm dark:border-dark-outline-variant/40 dark:bg-dark-surface-lowest"
                        value={p.personalChoice}
                        disabled={saving}
                        onChange={(e) => save(p.id, e.target.value as "D1" | "D2")}
                      >
                        <option value="D1">{classLabel("D1")}</option>
                        <option value="D2">{classLabel("D2")}</option>
                      </select>
                    </div>
                  </div>
                  {p.choiceConfirmedAt && (
                    <p className="mt-1 text-label-sm meta-copy">
                      Confirmed {new Date(p.choiceConfirmedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
                    </p>
                  )}
                </div>
              ))}
            </div>

            {saveError && <p className="text-label-sm text-red-700 dark:text-red-300">{saveError}</p>}

            <div>
              <p className="text-sm font-semibold text-on-surface dark:text-dark-on-surface">Recent calls</p>
              {view.recent.length === 0 ? (
                <p className="text-label-sm meta-copy">No calls yet.</p>
              ) : (
                <ul className="mt-1 space-y-1">
                  {view.recent.slice(0, 20).map((c) => (
                    <li key={c.callId} className="text-label-sm meta-copy">
                      {new Date(c.at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                      {" · "}{purposeLabel(c.purpose)}
                      {" · "}{c.provider}
                      {" · "}{callLabel(c)}
                      {c.withheldCount > 0 ? ` · ${c.withheldCount} held back` : ""}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
