"use client";

import { useState } from "react";
import type { ActionDefinitionView, ActionDefinitionsResponse } from "@oneon/contracts";
import { AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { useActionDefinitions } from "@/lib/hooks";

export function ActionsSettings() {
  const { data, error, mutate } = useActionDefinitions();
  const response = data as ActionDefinitionsResponse | undefined;
  const [pendingOff, setPendingOff] = useState<string | null>(null);
  // One save at a time: every row is disabled while any save runs, so no row's save can re-enable another.
  const [saving, setSaving] = useState<string | null>(null);
  const busy = saving !== null;
  const [errors, setErrors] = useState<Record<string, string>>({});

  const save = async (def: ActionDefinitionView, body: { enabled?: boolean; approvalMode?: string }) => {
    setSaving(def.type);
    setErrors((e) => ({ ...e, [def.type]: "" }));
    try {
      await apiFetch(
        `/api/action-definitions/${def.type}/config`,
        { method: "PUT", body: JSON.stringify(body) },
        { redirectOnAuth: false },
      );
      await mutate();
    } catch (err) {
      setErrors((e) => ({ ...e, [def.type]: err instanceof Error ? err.message : "Couldn't save. Try again." }));
    } finally {
      setSaving(null);
      setPendingOff((open) => (open === def.type ? null : open));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Actions</CardTitle>
        <p className="text-label-sm meta-copy">What Oneon may do on its own, and what needs your approval. Options stricter than each action's minimum are the only ones shown.</p>
      </CardHeader>
      <CardContent>
        {!response && error ? (
          <div className="state-content state-content-center py-8">
            <AlertTriangle className="h-8 w-8 text-red-500/80 dark:text-red-400/80" />
            <p className="state-error">Couldn&apos;t load action settings.</p>
          </div>
        ) : !response ? (
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
                      {def.lastChange ? ` · Changed by you, ${new Date(def.lastChange.changedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : ""}
                    </p>
                  </div>
                  {def.available ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="success">Available</Badge>
                      <Badge variant={def.enabled ? "success" : "default"}>{def.enabled ? "On" : "Off"}</Badge>
                      <label className="sr-only" htmlFor={`approval-${def.type}`}>Approval for {def.label}</label>
                      <select
                        id={`approval-${def.type}`}
                        className="rounded-eight border border-outline-variant/40 bg-surface-lowest px-2 py-1 text-sm dark:border-dark-outline-variant/40 dark:bg-dark-surface-lowest"
                        value={def.approval.mode}
                        disabled={busy}
                        onChange={(e) => save(def, { approvalMode: e.target.value })}
                      >
                        {def.approval.options.map((o) => (
                          <option key={o.mode} value={o.mode}>{o.label}</option>
                        ))}
                      </select>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        aria-label={`${def.enabled ? "Turn off" : "Turn on"} ${def.label}`}
                        onClick={() => (def.enabled ? setPendingOff(def.type) : save(def, { enabled: true }))}
                      >
                        {def.enabled ? "Turn off" : "Turn on"}
                      </Button>
                    </div>
                  ) : (
                    <Badge variant="default" className="normal-case tracking-normal">Unavailable: {def.unavailableReason}</Badge>
                  )}
                </div>

                {pendingOff === def.type && (
                  <div className="mt-2 rounded-eight border border-amber-500/35 bg-amber-500/10 p-3 text-sm text-amber-900 dark:border-amber-400/40 dark:bg-amber-500/15 dark:text-amber-100">
                    <p>Turn off {def.label}?{def.disableWarning ? ` ${def.disableWarning}` : ""}</p>
                    <div className="mt-2 flex gap-2">
                      <Button size="sm" variant="secondary" disabled={busy} onClick={() => setPendingOff(null)}>Keep on</Button>
                      <Button size="sm" variant="primary" disabled={busy} onClick={() => save(def, { enabled: false })}>Turn off</Button>
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
