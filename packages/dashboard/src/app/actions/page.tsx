"use client";

import { useState } from "react";
import { useActions } from "@/lib/hooks";
import { apiFetch } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Zap, Check, X } from "lucide-react";
import type { ActionsListResponse } from "@oneon/contracts";

const STATUS_OPTIONS = ["all", "proposed", "approved", "executed", "rejected"] as const;

function statusVariant(s: string) {
  switch (s) {
    case "proposed":
      return "warning" as const;
    case "approved":
    case "executed":
      return "success" as const;
    case "rejected":
      return "error" as const;
    default:
      return "default" as const;
  }
}

export default function ActionsPage() {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [offset, setOffset] = useState(0);
  const limit = 25;

  const queryParts: string[] = [`limit=${limit}`, `offset=${offset}`];
  if (statusFilter !== "all") queryParts.push(`status=${statusFilter}`);
  const query = queryParts.join("&");

  const { data, error, isLoading, mutate } = useActions(query);
  const response = data as ActionsListResponse | undefined;

  const handleAction = async (id: string, type: "approve" | "reject") => {
    try {
      await apiFetch(`/api/actions/${id}/${type}`, { method: "POST" });
      mutate();
    } catch {
      // Error will be reflected on next poll
    }
  };

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="space-y-2">
        <p className="text-label-md uppercase tracking-wider text-on-surface-variant/50 dark:text-dark-on-surface-variant/50">
          Operational Hub
        </p>
        <h1 className="text-display-md font-bold text-on-surface dark:text-dark-on-surface">
          Action Center
        </h1>
        <p className="text-on-surface-variant dark:text-dark-on-surface-variant">
          Review, validate, and execute agent-proposed actions.
        </p>
      </div>

      {/* Status filter */}
      <div className="flex gap-1">
        {STATUS_OPTIONS.map((s) => (
          <button
            key={s}
            onClick={() => { setStatusFilter(s); setOffset(0); }}
            className={`rounded-full px-3 py-1 text-label-md font-medium transition-colors ${
              statusFilter === s
                ? "bg-primary text-on-primary dark:bg-dark-primary dark:text-dark-on-primary"
                : "text-on-surface-variant hover:bg-surface-high dark:text-dark-on-surface-variant dark:hover:bg-dark-surface-high"
            }`}
          >
            {s === "all" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      {/* List */}
      {isLoading && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="animate-pulse">
              <div className="h-24" />
            </Card>
          ))}
        </div>
      )}

      {error && (
        <Card>
          <CardContent>
            <p className="text-red-500">Failed to load actions.</p>
          </CardContent>
        </Card>
      )}

      {response && (
        <>
          {response.actions.length === 0 ? (
            <Card>
              <CardContent>
                <p className="text-on-surface-variant dark:text-dark-on-surface-variant">
                  No actions match your filters.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              {response.actions.map((action) => (
                <Card key={action.id}>
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <CardTitle className="flex items-center gap-2">
                        <Zap className="h-4 w-4" />
                        {action.actionType.replace(/_/g, " ")}
                      </CardTitle>
                      <div className="flex items-center gap-2">
                        <Badge variant={statusVariant(action.status)}>
                          {action.status}
                        </Badge>
                        {action.riskLevel === "approval_required" && (
                          <Badge variant="warning">Approval Required</Badge>
                        )}
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {action.itemSubject && (
                      <p className="text-sm text-on-surface-variant dark:text-dark-on-surface-variant">
                        Re: {action.itemSubject}
                      </p>
                    )}
                    <div className="rounded-eight bg-surface-low p-4 dark:bg-dark-surface-low">
                      <p className="text-label-md uppercase tracking-wider text-on-surface-variant/50 dark:text-dark-on-surface-variant/50 mb-2">
                        Payload
                      </p>
                      <pre className="text-sm text-on-surface-variant dark:text-dark-on-surface-variant overflow-x-auto whitespace-pre-wrap">
                        {formatPayload(action.payloadJson)}
                      </pre>
                    </div>
                    <div className="flex items-center justify-between">
                      <p className="text-label-sm text-on-surface-variant/50 dark:text-dark-on-surface-variant/50">
                        Created{" "}
                        {new Date(action.createdAt).toLocaleString("en-US", {
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </p>
                      {action.status === "proposed" && (
                        <div className="flex gap-2">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => handleAction(action.id, "reject")}
                          >
                            <X className="h-4 w-4" />
                            Reject
                          </Button>
                          <Button
                            variant="primary"
                            size="sm"
                            onClick={() => handleAction(action.id, "approve")}
                          >
                            <Check className="h-4 w-4" />
                            Confirm Execution
                          </Button>
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {/* Pagination */}
          <div className="flex items-center justify-between pt-4">
            <p className="text-label-md text-on-surface-variant dark:text-dark-on-surface-variant">
              Showing {offset + 1}–{Math.min(offset + limit, response.pagination.total)} of{" "}
              {response.pagination.total}
            </p>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - limit))}
              >
                Previous
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={!response.pagination.hasMore}
                onClick={() => setOffset(offset + limit)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function formatPayload(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}
