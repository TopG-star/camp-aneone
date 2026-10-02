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
