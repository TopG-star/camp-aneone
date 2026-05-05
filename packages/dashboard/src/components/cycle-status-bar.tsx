"use client";

import { useMemo, useState } from "react";
import { useCycleErrors, useCycleStatus } from "@/lib/hooks";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";

interface CycleStatus {
  running: boolean;
  lastCycleAt: string | null;
  lastError: string | null;
  consecutiveErrors: number;
  enabled: boolean;
}

interface CycleErrorItem {
  id: string;
  occurredAt: string;
  component: string;
  stage: string;
  scope: "global" | "action";
  userId: string | null;
  message: string;
  actionId: string | null;
  actionHref: string | null;
}

interface CycleErrorsResponse {
  errors: CycleErrorItem[];
}

interface CycleErrorGroup {
  key: string;
  label: string;
  entries: CycleErrorItem[];
}

export function CycleStatusBar() {
  const { data, error, mutate } = useCycleStatus();
  const [componentFilter, setComponentFilter] = useState("");
  const [stageFilter, setStageFilter] = useState("");
  const [scopeFilter, setScopeFilter] = useState<"all" | "global" | "action">("all");
  const cycleErrorFilters = useMemo(
    () => ({
      limit: 25,
      component: componentFilter.trim() || null,
      stage: stageFilter.trim() || null,
      scope: scopeFilter === "all" ? null : scopeFilter,
    }),
    [componentFilter, stageFilter, scopeFilter],
  );
  const { data: errorsData, mutate: mutateErrors } = useCycleErrors(cycleErrorFilters);
  const status = data as CycleStatus | undefined;
  const cycleErrors = (errorsData as CycleErrorsResponse | undefined)?.errors ?? [];
  const groupedErrors = useMemo(() => groupCycleErrors(cycleErrors), [cycleErrors]);
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [retryingActionId, setRetryingActionId] = useState<string | null>(null);

  const handleTrigger = async () => {
    try {
      await apiFetch("/api/cycle/run-now", { method: "POST" });
      mutate();
    } catch {
      // swallow — the UI will reflect state on next poll
    }
  };

  const handleRetryExecution = async (actionId: string) => {
    setRetryingActionId(actionId);
    try {
      await apiFetch(`/api/actions/${actionId}/retry-execution`, { method: "POST" });
      await Promise.all([mutate(), mutateErrors()]);
    } catch {
      // swallow — failed retries are reflected by /api/cycle/errors polling
    } finally {
      setRetryingActionId(null);
    }
  };

  if (error) {
    return (
      <div className="flex items-center gap-2 text-label-md text-red-500">
        <span className="h-2 w-2 rounded-full bg-red-500" />
        Agent offline
      </div>
    );
  }

  if (!status) {
    return (
      <div className="flex items-center gap-2 text-label-md text-on-surface-variant/50 dark:text-dark-on-surface-variant/50">
        <span className="h-2 w-2 animate-pulse rounded-full bg-on-surface-variant/30" />
        Connecting...
      </div>
    );
  }

  const hasError = status.consecutiveErrors > 0;
  const statusLabel = !status.enabled
    ? "Agent disabled"
    : hasError
      ? `${status.consecutiveErrors} error${status.consecutiveErrors > 1 ? "s" : ""}`
      : status.running
        ? "Agent active"
        : "Agent idle";

  return (
    <div className="relative">
      <div className="glass flex items-center gap-2 rounded-full px-3 py-1.5 sm:gap-3 sm:px-4">
        <span
          className={cn(
            "h-2 w-2 rounded-full",
            hasError
              ? "bg-amber-500"
              : status.running
                ? "animate-pulse bg-emerald-500"
                : "bg-on-surface-variant/30 dark:bg-dark-on-surface-variant/30",
          )}
        />
        {hasError ? (
          <button
            type="button"
            onClick={() => setIsPanelOpen((open) => !open)}
            className="text-label-md text-on-surface-variant underline-offset-4 hover:underline dark:text-dark-on-surface-variant"
            aria-controls="cycle-error-panel"
          >
            {statusLabel}
          </button>
        ) : (
          <span className="text-label-md text-on-surface-variant dark:text-dark-on-surface-variant">
            {statusLabel}
          </span>
        )}
        {status.lastCycleAt && (
          <span className="hidden text-label-sm text-on-surface-variant/50 sm:inline dark:text-dark-on-surface-variant/50">
            {formatRelative(status.lastCycleAt)}
          </span>
        )}
        {status.running && (
          <button
            onClick={handleTrigger}
            className="ml-1 hidden text-label-sm font-medium text-on-surface hover:underline sm:inline dark:text-dark-on-surface"
          >
            Run now
          </button>
        )}
      </div>

      {hasError && isPanelOpen && (
        <div
          id="cycle-error-panel"
          className="absolute right-0 top-full z-30 mt-2 w-[min(92vw,36rem)] rounded-eight border border-outline-variant/40 bg-surface-lowest p-4 shadow-ambient dark:border-dark-outline-variant/40 dark:bg-dark-surface-container dark:shadow-ambient-dark"
        >
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <p className="text-label-md font-semibold text-on-surface dark:text-dark-on-surface">
                Last cycle errors
              </p>
              <p className="text-label-sm text-on-surface-variant/80 dark:text-dark-on-surface-variant/80">
                Grouped by component, stage, and user scope.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setIsPanelOpen(false)}
              className="text-label-sm text-on-surface-variant hover:text-on-surface dark:text-dark-on-surface-variant dark:hover:text-dark-on-surface"
            >
              Close
            </button>
          </div>

          <div className="max-h-[24rem] space-y-3 overflow-y-auto pr-1">
            <div className="grid grid-cols-1 gap-2 rounded-eight border border-outline-variant/30 bg-surface-low p-3 sm:grid-cols-3 dark:border-dark-outline-variant/30 dark:bg-dark-surface-low">
              <label className="text-label-sm text-on-surface-variant dark:text-dark-on-surface-variant">
                Component
                <input
                  value={componentFilter}
                  onChange={(event) => setComponentFilter(event.target.value)}
                  placeholder="e.g. actions"
                  className="mt-1 w-full rounded-six border border-outline-variant/40 bg-surface-lowest px-2 py-1 text-label-sm text-on-surface outline-none focus:border-outline dark:border-dark-outline-variant/40 dark:bg-dark-surface-container dark:text-dark-on-surface dark:focus:border-dark-outline"
                />
              </label>
              <label className="text-label-sm text-on-surface-variant dark:text-dark-on-surface-variant">
                Stage
                <input
                  value={stageFilter}
                  onChange={(event) => setStageFilter(event.target.value)}
                  placeholder="e.g. execute"
                  className="mt-1 w-full rounded-six border border-outline-variant/40 bg-surface-lowest px-2 py-1 text-label-sm text-on-surface outline-none focus:border-outline dark:border-dark-outline-variant/40 dark:bg-dark-surface-container dark:text-dark-on-surface dark:focus:border-dark-outline"
                />
              </label>
              <label className="text-label-sm text-on-surface-variant dark:text-dark-on-surface-variant">
                Scope
                <select
                  value={scopeFilter}
                  onChange={(event) => setScopeFilter(event.target.value as "all" | "global" | "action")}
                  className="mt-1 w-full rounded-six border border-outline-variant/40 bg-surface-lowest px-2 py-1 text-label-sm text-on-surface outline-none focus:border-outline dark:border-dark-outline-variant/40 dark:bg-dark-surface-container dark:text-dark-on-surface dark:focus:border-dark-outline"
                >
                  <option value="all">all</option>
                  <option value="global">global</option>
                  <option value="action">action</option>
                </select>
              </label>
            </div>

            {groupedErrors.length === 0 && (
              <p className="text-label-sm text-on-surface-variant/80 dark:text-dark-on-surface-variant/80">
                No errors match current filters.
              </p>
            )}

            {groupedErrors.map((group) => (
              <div
                key={group.key}
                className="rounded-eight border border-outline-variant/35 bg-surface-low p-3 dark:border-dark-outline-variant/35 dark:bg-dark-surface-low"
              >
                <p className="text-label-sm font-medium text-on-surface dark:text-dark-on-surface">
                  {group.label}
                </p>
                <div className="mt-2 space-y-2">
                  {group.entries.map((entry) => (
                    <div key={entry.id} className="rounded-six bg-surface-lowest/70 p-2 dark:bg-dark-surface-container/70">
                      <p className="text-label-sm text-on-surface dark:text-dark-on-surface">
                        {entry.message}
                      </p>
                      <p className="text-label-sm text-on-surface-variant/80 dark:text-dark-on-surface-variant/80">
                        {formatRelative(entry.occurredAt)}
                      </p>
                      {entry.scope === "action" && entry.actionId && (
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <a
                            href={entry.actionHref ?? `/actions#action-${entry.actionId}`}
                            className="text-label-sm font-medium text-on-surface underline-offset-4 hover:underline dark:text-dark-on-surface"
                          >
                            Open action
                          </a>
                          <button
                            type="button"
                            disabled={retryingActionId === entry.actionId}
                            onClick={() => void handleRetryExecution(entry.actionId!)}
                            className="text-label-sm font-medium text-on-surface underline-offset-4 hover:underline disabled:cursor-not-allowed disabled:opacity-60 dark:text-dark-on-surface"
                          >
                            {retryingActionId === entry.actionId ? "Retrying..." : "Retry execution"}
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function groupCycleErrors(errors: CycleErrorItem[]): CycleErrorGroup[] {
  const groups = new Map<string, CycleErrorGroup>();

  for (const error of errors) {
    const key = `${error.component}|${error.stage}|${error.userId ?? "all"}|${error.scope}`;
    const label = `${toLabel(error.component)} · ${toLabel(error.stage)} · ${
      error.userId ? `user ${error.userId}` : "all users"
    } · ${error.scope}`;

    const group = groups.get(key);
    if (group) {
      group.entries.push(error);
      continue;
    }

    groups.set(key, {
      key,
      label,
      entries: [error],
    });
  }

  return Array.from(groups.values());
}

function toLabel(value: string): string {
  return value.replace(/_/g, " ");
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ago`;
}
