"use client";

import { useState } from "react";
import { useDeadlines } from "@/lib/hooks";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CalendarClock, AlertTriangle, Filter } from "lucide-react";
import { getMotionDelayClass } from "@/lib/motion-utils";

interface DeadlineItem {
  id: string;
  itemId: string;
  subject: string;
  source: string;
  dueDate: string;
  status: string;
  isOverdue: boolean;
}

interface DeadlinesResponse {
  deadlines: DeadlineItem[];
  counts: { total: number; open: number; overdue: number };
}

const STATUS_OPTIONS = ["all", "open", "done", "dismissed"] as const;
const RANGE_OPTIONS = [
  { label: "7 days", value: "7" },
  { label: "14 days", value: "14" },
  { label: "30 days", value: "30" },
  { label: "90 days", value: "90" },
] as const;

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = d.getTime() - now.getTime();
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  const formatted = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });

  if (diffDays < 0) return `${formatted} (${Math.abs(diffDays)}d overdue)`;
  if (diffDays === 0) return `${formatted} (today)`;
  if (diffDays === 1) return `${formatted} (tomorrow)`;
  if (diffDays <= 7) return `${formatted} (${diffDays}d)`;
  return formatted;
}

export default function DeadlinesPage() {
  const [status, setStatus] = useState<string>("all");
  const [range, setRange] = useState<string>("30");

  const queryParts: string[] = [`range=${range}`];
  if (status !== "all") queryParts.push(`status=${status}`);
  const query = queryParts.join("&");

  const { data, error, isLoading } = useDeadlines(query);
  const response = data as DeadlinesResponse | undefined;

  return (
    <div className="space-y-6 md:space-y-7 lg:space-y-8 motion-page-enter">
      {/* Header */}
      <div className="space-y-2 motion-rise-in">
        <p className="page-eyebrow">
          Planning
        </p>
        <h1 className="page-title">
          Deadlines
        </h1>
        <p className="page-copy">
          Upcoming deadlines extracted from your messages and calendar.
        </p>
      </div>

      {/* Summary Counts */}
      {response && (
        <div className="grid gap-3 sm:grid-cols-3">
          <div
            className={`motion-rise-in-soft rounded-twelve border border-outline-variant/30 bg-surface-low px-4 py-3 dark:border-dark-outline-variant/30 dark:bg-dark-surface-low ${getMotionDelayClass(1)}`}
          >
            <span className="text-label-sm text-on-surface-variant dark:text-dark-on-surface-variant">
              Total
            </span>
            <p className="text-title-lg font-bold text-on-surface dark:text-dark-on-surface">
              {response.counts.total}
            </p>
          </div>
          <div
            className={`motion-rise-in-soft rounded-twelve border border-outline-variant/30 bg-surface-low px-4 py-3 dark:border-dark-outline-variant/30 dark:bg-dark-surface-low ${getMotionDelayClass(2)}`}
          >
            <span className="text-label-sm text-on-surface-variant dark:text-dark-on-surface-variant">
              Open
            </span>
            <p className="text-title-lg font-bold text-on-surface dark:text-dark-on-surface">
              {response.counts.open}
            </p>
          </div>
          <div
            className={`motion-rise-in-soft rounded-twelve border border-error/20 bg-error-container px-4 py-3 dark:border-dark-error/25 dark:bg-dark-error-container ${getMotionDelayClass(3)}`}
          >
            <span className="text-label-sm text-on-error-container dark:text-dark-on-error-container">
              Overdue
            </span>
            <p className="text-title-lg font-bold text-on-error-container dark:text-dark-on-error-container">
              {response.counts.overdue}
            </p>
          </div>
        </div>
      )}

      {/* Filters */}
      <div
        className={`motion-rise-in-soft space-y-2 ${getMotionDelayClass(2)}`}
      >
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-on-surface-variant dark:text-dark-on-surface-variant" />
          <span className="text-label-sm text-on-surface-variant dark:text-dark-on-surface-variant">
            Filters
          </span>
        </div>

        <div className="flex gap-1 overflow-x-auto pb-1">
          {STATUS_OPTIONS.map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              className={`filter-chip ${
                status === s
                  ? "filter-chip-active"
                  : "filter-chip-idle"
              }`}
            >
              {s === "all" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>

        <div className="flex gap-1 overflow-x-auto pb-1">
          {RANGE_OPTIONS.map(({ label, value }) => (
            <button
              key={value}
              onClick={() => setRange(value)}
              className={`filter-chip ${
                range === value
                  ? "filter-chip-active"
                  : "filter-chip-idle"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* List */}
      {isLoading && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Card key={i}>
              <div className="state-skeleton h-20" />
            </Card>
          ))}
        </div>
      )}

      {error && (
        <Card>
          <CardContent className="state-content state-content-center py-8">
            <AlertTriangle className="h-8 w-8 text-red-500/80 dark:text-red-400/80" />
            <p className="state-error">Failed to load deadlines. Please try again.</p>
          </CardContent>
        </Card>
      )}

      {response && response.deadlines.length === 0 && (
        <Card>
          <CardContent className="state-content state-content-center py-10">
            <CalendarClock className="state-icon" />
            <p className="state-title">
              No deadlines found for this time range.
            </p>
          </CardContent>
        </Card>
      )}

      {response && response.deadlines.length > 0 && (
        <div className="space-y-2 md:space-y-3">
          {response.deadlines.map((deadline, index) => (
            <Card
              key={deadline.id}
              className={
                deadline.isOverdue
                  ? `motion-rise-in-soft border-error/30 dark:border-dark-error/30 ${getMotionDelayClass(index + 2)}`
                  : `motion-rise-in-soft ${getMotionDelayClass(index + 2)}`
              }
            >
              <CardContent className="flex flex-col items-start gap-3 py-4 sm:flex-row sm:items-center sm:gap-4">
                {deadline.isOverdue ? (
                  <AlertTriangle className="h-5 w-5 shrink-0 text-error dark:text-dark-error" />
                ) : (
                  <CalendarClock className="h-5 w-5 shrink-0 text-on-surface-variant dark:text-dark-on-surface-variant" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-on-surface dark:text-dark-on-surface">
                    {deadline.subject}
                  </p>
                  <p className="text-label-md meta-copy">
                    {deadline.source} &middot; {formatDate(deadline.dueDate)}
                  </p>
                </div>
                <Badge
                  variant={
                    deadline.isOverdue
                      ? "error"
                      : deadline.status === "done"
                        ? "success"
                        : "default"
                  }
                    className="self-end sm:self-auto"
                >
                  {deadline.isOverdue ? "Overdue" : deadline.status}
                </Badge>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
