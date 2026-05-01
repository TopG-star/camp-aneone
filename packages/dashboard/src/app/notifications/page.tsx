"use client";

import { useNotifications } from "@/lib/hooks";
import { apiFetch } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Bell, CheckCheck, AlertTriangle } from "lucide-react";
import { getMotionDelayClass } from "@/lib/motion-utils";

interface Notification {
  id: string;
  type: string;
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
}

interface NotificationsResponse {
  notifications: Notification[];
}

function typeVariant(type: string) {
  switch (type) {
    case "deadline_approaching":
      return "warning" as const;
    case "action_proposed":
      return "default" as const;
    case "error":
      return "error" as const;
    default:
      return "default" as const;
  }
}

export default function NotificationsPage() {
  const { data, error, isLoading, mutate } = useNotifications();
  const response = data as NotificationsResponse | undefined;

  const markAllRead = async () => {
    try {
      await apiFetch("/api/notifications/read-all", { method: "POST" });
      mutate();
    } catch {
      // swallow
    }
  };

  const markRead = async (id: string) => {
    try {
      await apiFetch(`/api/notifications/${id}/read`, { method: "PATCH" });
      mutate();
    } catch {
      // swallow
    }
  };

  return (
    <div className="space-y-6 md:space-y-7 lg:space-y-8 motion-page-enter">
      {/* Header */}
      <div className="flex flex-col gap-3 motion-rise-in sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <p className="page-eyebrow">
            Alerts
          </p>
          <h1 className="page-title">
            Notifications
          </h1>
          <p className="page-copy">
            Latest system and workflow updates from your agent.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={markAllRead}
          className="w-full justify-center sm:w-auto"
        >
          <CheckCheck className="h-4 w-4" />
          Mark all read
        </Button>
      </div>

      {/* List */}
      {isLoading && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Card key={i}>
              <div className="state-skeleton h-16" />
            </Card>
          ))}
        </div>
      )}

      {error && (
        <Card>
          <CardContent className="state-content state-content-center py-8">
            <AlertTriangle className="h-8 w-8 text-red-500/80 dark:text-red-400/80" />
            <p className="state-error">Failed to load notifications.</p>
          </CardContent>
        </Card>
      )}

      {response && (
        <>
          {(!response.notifications || response.notifications.length === 0) ? (
            <Card>
              <CardContent className="state-content state-content-center py-10">
                <Bell className="state-icon" />
                <p className="state-title">
                  No notifications
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-2 md:space-y-3">
              {response.notifications.map((n, index) => (
                <Card
                  key={n.id}
                  className={`motion-interactive motion-rise-in-soft cursor-pointer transition-colors hover:bg-surface-low dark:hover:bg-dark-surface-high ${getMotionDelayClass(index + 1)} ${
                    !n.read ? "ghost-border-dark" : "opacity-70"
                  }`}
                  onClick={() => !n.read && markRead(n.id)}
                >
                  <CardContent className="flex items-start gap-4">
                    {!n.read && (
                      <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-primary dark:bg-dark-primary" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                        <p className="font-medium text-on-surface dark:text-dark-on-surface">
                          {n.title}
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant={typeVariant(n.type)}>
                            {n.type.replace(/_/g, " ")}
                          </Badge>
                          <span className="text-label-sm meta-copy">
                            {new Date(n.createdAt).toLocaleString("en-US", {
                              month: "short",
                              day: "numeric",
                              hour: "numeric",
                              minute: "2-digit",
                            })}
                          </span>
                        </div>
                      </div>
                      <p className="text-sm meta-copy">
                        {n.body}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
