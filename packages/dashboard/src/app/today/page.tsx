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
} from "lucide-react";
import Link from "next/link";

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
      <div className="space-y-6">
        <div className="space-y-2">
          <p className="text-label-md uppercase tracking-wider text-on-surface-variant/50 dark:text-dark-on-surface-variant/50">
            Operational Hub
          </p>
          <h1 className="text-display-md font-bold text-on-surface dark:text-dark-on-surface">
            Today
          </h1>
        </div>
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="animate-pulse">
              <div className="h-32" />
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-4">
        <h1 className="text-display-md font-bold">Today</h1>
        <Card>
          <CardContent>
            <p className="text-red-500">Failed to load dashboard data. Is the agent server running?</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!today) return null;

  return (
    <div className="space-y-8">
      {/* Hero header */}
      <div className="space-y-2">
        <p className="text-label-md uppercase tracking-wider text-on-surface-variant/50 dark:text-dark-on-surface-variant/50">
          Operational Hub
        </p>
        <h1 className="text-display-md font-bold text-on-surface dark:text-dark-on-surface">
          Today
        </h1>
        <p className="text-on-surface-variant dark:text-dark-on-surface-variant">
          {new Date(today.date).toLocaleDateString("en-US", {
            weekday: "long",
            month: "long",
            day: "numeric",
            year: "numeric",
          })}
        </p>
      </div>

      {/* Quick stats row */}
      <div className="grid gap-4 md:grid-cols-3">
        <Link href="/inbox">
          <Card className="group cursor-pointer transition-colors hover:bg-surface-low dark:hover:bg-dark-surface-high">
            <CardContent className="flex items-center gap-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-eight bg-surface-high dark:bg-dark-surface-high">
                <Inbox className="h-5 w-5" />
              </div>
              <div>
                <p className="text-2xl font-bold">{today.counts.totalInbox}</p>
                <p className="text-label-md text-on-surface-variant dark:text-dark-on-surface-variant">
                  Total Inbox
                </p>
              </div>
            </CardContent>
          </Card>
        </Link>

        <Link href="/actions">
          <Card className="group cursor-pointer transition-colors hover:bg-surface-low dark:hover:bg-dark-surface-high">
            <CardContent className="flex items-center gap-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-eight bg-surface-high dark:bg-dark-surface-high">
                <Zap className="h-5 w-5" />
              </div>
              <div>
                <p className="text-2xl font-bold">{today.counts.pendingActions}</p>
                <p className="text-label-md text-on-surface-variant dark:text-dark-on-surface-variant">
                  Pending Actions
                </p>
              </div>
            </CardContent>
          </Card>
        </Link>

        <Link href="/notifications">
          <Card className="group cursor-pointer transition-colors hover:bg-surface-low dark:hover:bg-dark-surface-high">
            <CardContent className="flex items-center gap-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-eight bg-surface-high dark:bg-dark-surface-high">
                <Bell className="h-5 w-5" />
              </div>
              <div>
                <p className="text-2xl font-bold">{today.counts.unreadNotifications}</p>
                <p className="text-label-md text-on-surface-variant dark:text-dark-on-surface-variant">
                  Unread Notifications
                </p>
              </div>
            </CardContent>
          </Card>
        </Link>
      </div>

      {/* Main content grid — asymmetric layout per design system */}
      <div className="grid gap-6 lg:grid-cols-5">
        {/* Left column — 3/5 */}
        <div className="space-y-6 lg:col-span-3">
          {/* Urgent items */}
          {today.urgentItems.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4" />
                  Urgent Items
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {today.urgentItems.map((item) => (
                  <Link
                    key={item.id}
                    href={`/inbox?id=${item.id}`}
                    className="block rounded-eight p-3 transition-colors hover:bg-surface-low dark:hover:bg-dark-surface-high"
                  >
                    <div className="flex items-center justify-between">
                      <p className="font-medium text-on-surface dark:text-dark-on-surface">
                        {item.subject}
                      </p>
                      <Badge variant="priority">P{item.priority}</Badge>
                    </div>
                    <p className="text-label-md text-on-surface-variant dark:text-dark-on-surface-variant">
                      {item.source} · {item.category}
                    </p>
                  </Link>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Pending actions preview */}
          {today.pendingActions.count > 0 && (
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2">
                    <Zap className="h-4 w-4" />
                    Pending Actions
                  </CardTitle>
                  <Link
                    href="/actions"
                    className="text-label-md font-medium text-on-surface hover:underline dark:text-dark-on-surface"
                  >
                    View all →
                  </Link>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {today.pendingActions.items.slice(0, 5).map((action) => (
                  <div
                    key={action.id}
                    className="flex items-center justify-between rounded-eight p-3 bg-surface-low dark:bg-dark-surface-low"
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
        <div className="space-y-6 lg:col-span-2">
          {/* Calendar */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CalendarDays className="h-4 w-4" />
                Calendar
              </CardTitle>
            </CardHeader>
            <CardContent>
              {today.calendar.status !== "connected" ? (
                <p className="text-sm text-on-surface-variant dark:text-dark-on-surface-variant">
                  Calendar not connected
                </p>
              ) : today.calendar.events.length === 0 ? (
                <p className="text-sm text-on-surface-variant dark:text-dark-on-surface-variant">
                  No events today
                </p>
              ) : (
                <div className="space-y-3">
                  {today.calendar.events.map((ev) => (
                    <div
                      key={ev.id}
                      className="rounded-eight p-3 bg-surface-low dark:bg-dark-surface-low"
                    >
                      <p className="font-medium text-on-surface dark:text-dark-on-surface">
                        {ev.title}
                      </p>
                      {!ev.allDay && (
                        <p className="text-label-md text-on-surface-variant dark:text-dark-on-surface-variant">
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
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Clock className="h-4 w-4" />
                Deadlines (7 days)
              </CardTitle>
            </CardHeader>
            <CardContent>
              {today.deadlines.length === 0 ? (
                <p className="text-sm text-on-surface-variant dark:text-dark-on-surface-variant">
                  No upcoming deadlines
                </p>
              ) : (
                <div className="space-y-3">
                  {today.deadlines.map((dl) => (
                    <div
                      key={dl.id}
                      className="rounded-eight p-3 bg-surface-low dark:bg-dark-surface-low"
                    >
                      <p className="font-medium text-on-surface dark:text-dark-on-surface">
                        {dl.description}
                      </p>
                      <p className="text-label-md text-on-surface-variant dark:text-dark-on-surface-variant">
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
