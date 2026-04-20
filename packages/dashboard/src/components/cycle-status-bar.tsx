"use client";

import { useCycleStatus } from "@/lib/hooks";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";

interface CycleStatus {
  running: boolean;
  lastCycleAt: string | null;
  lastError: string | null;
  consecutiveErrors: number;
  enabled: boolean;
}

export function CycleStatusBar() {
  const { data, error, mutate } = useCycleStatus();
  const status = data as CycleStatus | undefined;

  const handleTrigger = async () => {
    try {
      await apiFetch("/api/cycle/run-now", { method: "POST" });
      mutate();
    } catch {
      // swallow — the UI will reflect state on next poll
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

  return (
    <div className="glass dark:glass flex items-center gap-3 rounded-full px-4 py-1.5">
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
      <span className="text-label-md text-on-surface-variant dark:text-dark-on-surface-variant">
        {hasError
          ? `${status.consecutiveErrors} error${status.consecutiveErrors > 1 ? "s" : ""}`
          : status.running
            ? "Agent active"
            : "Agent idle"}
      </span>
      {status.lastCycleAt && (
        <span className="text-label-sm text-on-surface-variant/50 dark:text-dark-on-surface-variant/50">
          {formatRelative(status.lastCycleAt)}
        </span>
      )}
      {status.running && (
        <button
          onClick={handleTrigger}
          className="ml-1 text-label-sm font-medium text-on-surface hover:underline dark:text-dark-on-surface"
        >
          Run now
        </button>
      )}
    </div>
  );
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
