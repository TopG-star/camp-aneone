"use client";

import { useState } from "react";
import { useToday } from "@/lib/hooks";
import { apiFetch } from "@/lib/api";
import { Card, CardTitle, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Inbox,
  Zap,
  Bell,
  CalendarDays,
  AlertTriangle,
  Clock,
  CheckCircle2,
} from "lucide-react";
import Link from "next/link";
import { getMotionDelayClass } from "@/lib/motion-utils";

interface TodayData {
  date: string;
  briefingSummary: string | null;
  calendar: {
    status: string;
    events: Array<{ id: string; title: string; start: string; end: string; allDay: boolean; location: string | null }>;
  };
  urgentItems: Array<{ id: string; subject: string; source: string; priority: number; category: string }>;
  deadlines: Array<{ id: string; description: string; dueDate: string; status: string }>;
  triageQueue: Array<{
    id: string;
    kind: "urgent_email" | "teams_incident" | "pr_review" | "deadline_pressure";
    source: string;
    title: string;
    reason: string;
    primaryReason: string;
    signals: string[];
    score: number;
    href: string;
    observedAt: string;
    lastUpdatedAt: string;
    occurredAt: string;
  }>;
  pendingActions: { count: number; items: Array<{ id: string; actionType: string; resourceId: string }> };
  counts: { unreadNotifications: number; totalInbox: number; pendingActions: number };
}

function triageKindLabel(kind: TodayData["triageQueue"][number]["kind"]): string {
  switch (kind) {
    case "urgent_email":
      return "Urgent Email";
    case "teams_incident":
      return "Teams Incident";
    case "pr_review":
      return "PR Review";
    case "deadline_pressure":
      return "Deadline";
    default:
      return "Triage";
  }
}

function triageKindVariant(
  kind: TodayData["triageQueue"][number]["kind"],
): "default" | "priority" | "success" | "warning" | "error" {
  switch (kind) {
    case "deadline_pressure":
      return "error";
    case "teams_incident":
      return "warning";
    case "pr_review":
      return "priority";
    case "urgent_email":
      return "success";
    default:
      return "default";
  }
}

export default function TodayPage() {
  const { data, error, isLoading, mutate } = useToday();
  const [triageActionBusy, setTriageActionBusy] = useState<Record<string, boolean>>({});
  const today = data as TodayData | undefined;

  const handleTriageAction = async (itemId: string, action: "snooze" | "dismiss") => {
    try {
      setTriageActionBusy((previous) => ({ ...previous, [itemId]: true }));
      await apiFetch(`/api/today/triage/${encodeURIComponent(itemId)}/${action}`, {
        method: "POST",
        body: JSON.stringify(action === "snooze" ? { hours: 24 } : {}),
      });
      await mutate();
    } finally {
      setTriageActionBusy((previous) => ({ ...previous, [itemId]: false }));
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-6 motion-page-enter">
        <div className="space-y-2 motion-rise-in">
          <p className="page-eyebrow">Operational Hub</p>
          <h1 className="page-title">Today</h1>
        </div>
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Card key={i}>
              <div className="state-skeleton h-32" />
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-4 motion-page-enter">
        <h1 className="page-title">Today</h1>
        <Card>
          <CardContent className="state-content state-content-center py-8">
            <AlertTriangle className="h-8 w-8 text-red-500/80 dark:text-red-400/80" />
            <p className="state-error">Failed to load dashboard data. Is the agent server running?</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!today) return null;

  return (
    <div className="space-y-6 md:space-y-7 lg:space-y-8 motion-page-enter">
      <div className="space-y-2 motion-rise-in">
        <p className="page-eyebrow">Operational Hub</p>
        <h1 className="page-title">Today</h1>
        <p className="page-copy">
          {new Date(today.date).toLocaleDateString("en-US", {
            weekday: "long",
            month: "long",
            day: "numeric",
            year: "numeric",
          })}
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-3 md:gap-4">
        <Link href="/inbox">
          <Card className={`group motion-interactive motion-rise-in-soft cursor-pointer transition-colors hover:bg-surface-low dark:hover:bg-dark-surface-high ${getMotionDelayClass(0)}`}>
            <CardContent className="flex items-center gap-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-eight bg-surface-high dark:bg-dark-surface-high">
                <Inbox className="h-5 w-5" />
              </div>
              <div>
                <p className="text-2xl font-bold">{today.counts.totalInbox}</p>
                <p className="text-label-md meta-copy">Total Inbox</p>
              </div>
            </CardContent>
          </Card>
        </Link>

        <Link href="/actions">
          <Card className={`group motion-interactive motion-rise-in-soft cursor-pointer transition-colors hover:bg-surface-low dark:hover:bg-dark-surface-high ${getMotionDelayClass(1)}`}>
            <CardContent className="flex items-center gap-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-eight bg-surface-high dark:bg-dark-surface-high">
                <Zap className="h-5 w-5" />
              </div>
              <div>
                <p className="text-2xl font-bold">{today.counts.pendingActions}</p>
                <p className="text-label-md meta-copy">Pending Actions</p>
              </div>
            </CardContent>
          </Card>
        </Link>

        <Link href="/notifications">
          <Card className={`group motion-interactive motion-rise-in-soft cursor-pointer transition-colors hover:bg-surface-low dark:hover:bg-dark-surface-high ${getMotionDelayClass(2)}`}>
            <CardContent className="flex items-center gap-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-eight bg-surface-high dark:bg-dark-surface-high">
                <Bell className="h-5 w-5" />
              </div>
              <div>
                <p className="text-2xl font-bold">{today.counts.unreadNotifications}</p>
                <p className="text-label-md meta-copy">Unread Notifications</p>
              </div>
            </CardContent>
          </Card>
        </Link>
      </div>

      <Card className={`motion-rise-in-soft ${getMotionDelayClass(3)}`}>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              {new Date(today.date).getDay() === 1 ? "Monday Triage Queue" : "Triage Queue"}
            </CardTitle>
            <Badge variant="priority">Unified Queue</Badge>
          </div>
        </CardHeader>
        <CardContent>
          {today.triageQueue.length === 0 ? (
            <div className="inline-state">
              <CheckCircle2 className="inline-state-icon" />
              <p>No cross-system triage items right now</p>
            </div>
          ) : (
            <div className="space-y-3">
              {today.triageQueue.slice(0, 8).map((item, index) => (
                <div
                  key={item.id}
                  className={`motion-interactive motion-rise-in-soft rounded-eight border border-outline-variant/25 bg-surface-low p-3 transition-colors hover:bg-surface-high dark:border-dark-outline-variant/25 dark:bg-dark-surface-low dark:hover:bg-dark-surface-high ${getMotionDelayClass(index + 1)}`}
                >
                  <div className="flex flex-col gap-3">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div className="space-y-1">
                        <p className="font-medium text-on-surface dark:text-dark-on-surface">{item.title}</p>
                        <p className="text-label-md meta-copy">{item.reason}</p>
                        <p className="text-label-sm meta-copy">
                          Observed {new Date(item.observedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                          {" · "}
                          Updated {new Date(item.lastUpdatedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant={triageKindVariant(item.kind)}>{triageKindLabel(item.kind)}</Badge>
                        <Badge>Score {item.score}</Badge>
                      </div>
                    </div>

                    <details className="rounded-eight border border-outline-variant/25 bg-white/65 p-3 dark:border-dark-outline-variant/25 dark:bg-dark-surface">
                      <summary
                        className="cursor-pointer text-label-sm font-medium text-on-surface dark:text-dark-on-surface"
                        title={item.primaryReason}
                      >
                        Why
                      </summary>
                      <div className="mt-2 space-y-1">
                        <p className="text-label-sm text-on-surface-variant dark:text-dark-on-surface-variant">
                          {item.primaryReason}
                        </p>
                        {item.signals.length > 0 && (
                          <ul className="list-disc pl-5 text-label-sm text-on-surface-variant dark:text-dark-on-surface-variant">
                            {item.signals.map((signal) => (
                              <li key={`${item.id}-${signal}`}>{signal}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </details>

                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={item.href} className="text-label-sm font-medium text-on-surface hover:underline dark:text-dark-on-surface">
                        Open item
                      </Link>
                      <button
                        type="button"
                        className="rounded-full border border-outline-variant/40 px-3 py-1 text-label-sm text-on-surface disabled:opacity-50 dark:border-dark-outline-variant/40 dark:text-dark-on-surface"
                        disabled={triageActionBusy[item.id] === true}
                        onClick={() => handleTriageAction(item.id, "snooze")}
                      >
                        Snooze 24h
                      </button>
                      <button
                        type="button"
                        className="rounded-full border border-outline-variant/40 px-3 py-1 text-label-sm text-on-surface disabled:opacity-50 dark:border-dark-outline-variant/40 dark:text-dark-on-surface"
                        disabled={triageActionBusy[item.id] === true}
                        onClick={() => handleTriageAction(item.id, "dismiss")}
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-5 md:gap-6 lg:grid-cols-5">
        <div className="space-y-5 md:space-y-6 lg:col-span-3">
          {today.urgentItems.length === 0 && today.pendingActions.count === 0 && (
            <Card className={`motion-rise-in-soft ${getMotionDelayClass(3)}`}>
              <CardContent className="state-content state-content-center py-10">
                <CheckCircle2 className="h-10 w-10 text-emerald-600/80 dark:text-emerald-400/80" />
                <p className="state-title">All clear</p>
                <p className="state-subtext">No urgent inbox items or pending actions right now.</p>
              </CardContent>
            </Card>
          )}

          {today.urgentItems.length > 0 && (
            <Card className={`motion-rise-in-soft ${getMotionDelayClass(3)}`}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4" />
                  Urgent Items
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {today.urgentItems.map((item, index) => (
                  <Link
                    key={item.id}
                    href={`/inbox?id=${item.id}`}
                    className={`motion-interactive motion-rise-in-soft block rounded-eight p-3 transition-colors hover:bg-surface-low dark:hover:bg-dark-surface-high ${getMotionDelayClass(index + 1)}`}
                  >
                    <div className="flex items-center justify-between">
                      <p className="font-medium text-on-surface dark:text-dark-on-surface">{item.subject}</p>
                      <Badge variant="priority">P{item.priority}</Badge>
                    </div>
                    <p className="text-label-md meta-copy">{item.source} · {item.category}</p>
                  </Link>
                ))}
              </CardContent>
            </Card>
          )}

          {today.pendingActions.count > 0 && (
            <Card className={`motion-rise-in-soft ${getMotionDelayClass(4)}`}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2">
                    <Zap className="h-4 w-4" />
                    Pending Actions
                  </CardTitle>
                  <Link
                    href="/actions"
                    className="text-label-md font-medium text-on-surface hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface dark:text-dark-on-surface dark:focus-visible:ring-dark-primary/45 dark:focus-visible:ring-offset-dark-surface"
                  >
                    View all →
                  </Link>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {today.pendingActions.items.slice(0, 5).map((action, index) => (
                  <div
                    key={action.id}
                    className={`motion-rise-in-soft flex items-center justify-between rounded-eight bg-surface-low p-3 dark:bg-dark-surface-low ${getMotionDelayClass(index + 1)}`}
                  >
                    <p className="font-medium text-on-surface dark:text-dark-on-surface">
                      {action.actionType.replace(/_/g, " ")}
                    </p>
                    <Badge>Proposed</Badge>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-5 md:space-y-6 lg:col-span-2">
          <Card className={`motion-rise-in-soft ${getMotionDelayClass(5)}`}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CalendarDays className="h-4 w-4" />
                Calendar
              </CardTitle>
            </CardHeader>
            <CardContent>
              {today.calendar.status !== "connected" ? (
                <div className="inline-state">
                  <CalendarDays className="inline-state-icon" />
                  <p>Calendar not connected</p>
                </div>
              ) : today.calendar.events.length === 0 ? (
                <div className="inline-state">
                  <CalendarDays className="inline-state-icon" />
                  <p>No events today</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {today.calendar.events.map((ev, index) => (
                    <div
                      key={ev.id}
                      className={`motion-rise-in-soft rounded-eight bg-surface-low p-3 dark:bg-dark-surface-low ${getMotionDelayClass(index + 1)}`}
                    >
                      <p className="font-medium text-on-surface dark:text-dark-on-surface">{ev.title}</p>
                      {!ev.allDay && (
                        <p className="text-label-md meta-copy">
                          {new Date(ev.start).toLocaleTimeString("en-US", {
                            hour: "numeric",
                            minute: "2-digit",
                          })}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className={`motion-rise-in-soft ${getMotionDelayClass(6)}`}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Clock className="h-4 w-4" />
                Deadlines (7 days)
              </CardTitle>
            </CardHeader>
            <CardContent>
              {today.deadlines.length === 0 ? (
                <div className="inline-state">
                  <Clock className="inline-state-icon" />
                  <p>No upcoming deadlines</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {today.deadlines.map((dl, index) => (
                    <div
                      key={dl.id}
                      className={`motion-rise-in-soft rounded-eight bg-surface-low p-3 dark:bg-dark-surface-low ${getMotionDelayClass(index + 1)}`}
                    >
                      <p className="font-medium text-on-surface dark:text-dark-on-surface">{dl.description}</p>
                      <p className="text-label-md meta-copy">
                        Due {new Date(dl.dueDate).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
