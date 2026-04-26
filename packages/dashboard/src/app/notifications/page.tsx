"use client";

import { useNotifications } from "@/lib/hooks";
import { apiFetch } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Bell, CheckCheck } from "lucide-react";
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
    <div className="space-y-8 motion-page-enter">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 motion-rise-in">
        <div className="space-y-2">
          <p className="text-label-md uppercase tracking-wider text-on-surface-variant/50 dark:text-dark-on-surface-variant/50">
            Alerts
          </p>
          <h1 className="text-display-md font-bold text-on-surface dark:text-dark-on-surface">
            Notifications
          </h1>
        </div>
        <Button variant="ghost" size="sm" onClick={markAllRead} className="shrink-0">
          <CheckCheck className="h-4 w-4" />
          Mark all read
        </Button>
      </div>

      {/* List */}
      {isLoading && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="animate-pulse">
              <div className="h-16" />
            </Card>
          ))}
        </div>
      )}

      {error && (
        <Card>
          <CardContent>
            <p className="text-red-500">Failed to load notifications.</p>
          </CardContent>
        </Card>
      )}

      {response && (
        <>
          {(!response.notifications || response.notifications.length === 0) ? (
            <Card>
              <CardContent className="flex flex-col items-center py-12">
                <Bell className="mb-4 h-12 w-12 text-on-surface-variant/20 dark:text-dark-on-surface-variant/20" />
                <p className="text-on-surface-variant dark:text-dark-on-surface-variant">
                  No notifications
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-2">
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
                      <div className="flex items-center justify-between gap-4">
                        <p className="font-medium text-on-surface dark:text-dark-on-surface">
                          {n.title}
                        </p>
                        <div className="flex items-center gap-2 shrink-0">
                          <Badge variant={typeVariant(n.type)}>
                            {n.type.replace(/_/g, " ")}
                          </Badge>
                          <span className="text-label-sm text-on-surface-variant/50 dark:text-dark-on-surface-variant/50">
                            {new Date(n.createdAt).toLocaleString("en-US", {
                              month: "short",
                              day: "numeric",
                              hour: "numeric",
                              minute: "2-digit",
                            })}
                          </span>
                        </div>
                      </div>
                      <p className="text-sm text-on-surface-variant dark:text-dark-on-surface-variant">
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
