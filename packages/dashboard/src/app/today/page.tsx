"use client";

import { useToday } from "@/lib/hooks";
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

// NOTE: Local type until TodayResponse contract is aligned with actual API shape (see T4-1)
interface TodayData {
  date: string;
  briefingSummary: string | null;
  calendar: {
    status: string;
    events: Array<{ id: string; title: string; start: string; end: string; allDay: boolean; location: string | null }>;
  };
  urgentItems: Array<{ id: string; subject: string; source: string; priority: number; category: string }>;
  deadlines: Array<{ id: string; description: string; dueDate: string; status: string }>;
  pendingActions: { count: number; items: Array<{ id: string; actionType: string; resourceId: string }> };
  counts: { unreadNotifications: number; totalInbox: number; pendingActions: number };
}

export default function TodayPage() {
  const { data, error, isLoading } = useToday();
  const today = data as TodayData | undefined;

  if (isLoading) {
    return (
      <div className="space-y-6 motion-page-enter">
        <div className="space-y-2 motion-rise-in">
          <p className="page-eyebrow">
            Operational Hub
          </p>
          <h1 className="page-title">
            Today
          </h1>
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
      {/* Hero header */}
      <div className="space-y-2 motion-rise-in">
        <p className="page-eyebrow">
          Operational Hub
        </p>
        <h1 className="page-title">
          Today
        </h1>
        <p className="page-copy">
          {new Date(today.date).toLocaleDateString("en-US", {
            weekday: "long",
            month: "long",
            day: "numeric",
            year: "numeric",
          })}
        </p>
      </div>

      {/* Quick stats row */}
      <div className="grid gap-3 md:grid-cols-3 md:gap-4">
        <Link href="/inbox">
          <Card
            className={`group motion-interactive motion-rise-in-soft cursor-pointer transition-colors hover:bg-surface-low dark:hover:bg-dark-surface-high ${getMotionDelayClass(0)}`}
          >
            <CardContent className="flex items-center gap-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-eight bg-surface-high dark:bg-dark-surface-high">
                <Inbox className="h-5 w-5" />
              </div>
              <div>
                <p className="text-2xl font-bold">{today.counts.totalInbox}</p>
                <p className="text-label-md meta-copy">
                  Total Inbox
                </p>
              </div>
            </CardContent>
          </Card>
        </Link>

        <Link href="/actions">
          <Card
            className={`group motion-interactive motion-rise-in-soft cursor-pointer transition-colors hover:bg-surface-low dark:hover:bg-dark-surface-high ${getMotionDelayClass(1)}`}
          >
            <CardContent className="flex items-center gap-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-eight bg-surface-high dark:bg-dark-surface-high">
                <Zap className="h-5 w-5" />
              </div>
              <div>
                <p className="text-2xl font-bold">{today.counts.pendingActions}</p>
                <p className="text-label-md meta-copy">
                  Pending Actions
                </p>
              </div>
            </CardContent>
          </Card>
        </Link>

        <Link href="/notifications">
          <Card
            className={`group motion-interactive motion-rise-in-soft cursor-pointer transition-colors hover:bg-surface-low dark:hover:bg-dark-surface-high ${getMotionDelayClass(2)}`}
          >
            <CardContent className="flex items-center gap-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-eight bg-surface-high dark:bg-dark-surface-high">
                <Bell className="h-5 w-5" />
              </div>
              <div>
                <p className="text-2xl font-bold">{today.counts.unreadNotifications}</p>
                <p className="text-label-md meta-copy">
                  Unread Notifications
                </p>
              </div>
            </CardContent>
          </Card>
        </Link>
      </div>

      {/* Main content grid — asymmetric layout per design system */}
      <div className="grid gap-5 md:gap-6 lg:grid-cols-5">
        {/* Left column — 3/5 */}
        <div className="space-y-5 md:space-y-6 lg:col-span-3">
          {/* Empty summary when no urgent work is queued */}
          {today.urgentItems.length === 0 && today.pendingActions.count === 0 && (
            <Card className={`motion-rise-in-soft ${getMotionDelayClass(3)}`}>
              <CardContent className="state-content state-content-center py-10">
                <CheckCircle2 className="h-10 w-10 text-emerald-600/80 dark:text-emerald-400/80" />
                <p className="state-title">All clear</p>
                <p className="state-subtext">
                  No urgent inbox items or pending actions right now.
                </p>
              </CardContent>
            </Card>
          )}

          {/* Urgent items */}
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
                      <p className="font-medium text-on-surface dark:text-dark-on-surface">
                        {item.subject}
                      </p>
                      <Badge variant="priority">P{item.priority}</Badge>
                    </div>
                    <p className="text-label-md meta-copy">
                      {item.source} · {item.category}
                    </p>
                  </Link>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Pending actions preview */}
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
                    <div>
                      <p className="font-medium text-on-surface dark:text-dark-on-surface">
                        {action.actionType.replace(/_/g, " ")}
                      </p>
                    </div>
                    <Badge>Proposed</Badge>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>

        {/* Right column — 2/5 */}
        <div className="space-y-5 md:space-y-6 lg:col-span-2">
          {/* Calendar */}
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
                      <p className="font-medium text-on-surface dark:text-dark-on-surface">
                        {ev.title}
                      </p>
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

          {/* Upcoming deadlines */}
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
                      <p className="font-medium text-on-surface dark:text-dark-on-surface">
                        {dl.description}
                      </p>
                      <p className="text-label-md meta-copy">
                        Due {new Date(dl.dueDate).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                        })}
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
