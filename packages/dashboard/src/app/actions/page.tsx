"use client";

import { useEffect, useMemo, useState } from "react";
import { useAction, useActions } from "@/lib/hooks";
import { apiFetch } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Zap, Check, X, AlertTriangle } from "lucide-react";
import type { ActionItemResponse, ActionResponse, ActionsListResponse } from "@oneon/contracts";
import { getMotionDelayClass } from "@/lib/motion-utils";

const STATUS_OPTIONS = ["all", "proposed", "approved", "executed", "rejected", "rolled_back"] as const;

const REASON_DETAILS: Record<string, { ruleName: string; summary: string }> = {
  urgent_category: {
    ruleName: "Urgent Attention Rule",
    summary: "Classified as urgent, so Alfred proposes immediate visibility.",
  },
  high_priority: {
    ruleName: "Priority Threshold Rule",
    summary: "Priority score was high enough to trigger proactive attention.",
  },
  follow_up_needed: {
    ruleName: "Follow-up Draft Rule",
    summary: "Classifier flagged follow-up as needed, so a draft action was proposed.",
  },
  spam_classification: {
    ruleName: "Spam Cleanup Rule",
    summary: "Classified as spam, so Alfred proposes mailbox cleanup.",
  },
  newsletter_low_priority: {
    ruleName: "Newsletter Organization Rule",
    summary: "Low-priority newsletter matched labeling policy for later reading.",
  },
};

const ACTION_FALLBACK_RULES: Record<string, string> = {
  create_reminder: "Deadline Reminder Rule",
  notify: "Attention Notification Rule",
  draft_reply: "Draft Preparation Rule",
  archive: "Mailbox Cleanup Rule",
  label: "Mailbox Organization Rule",
};

type ParsedPayload = Record<string, unknown> | null;

interface ActionContextSummary {
  ruleName: string;
  reasonCode: string | null;
  reasonSummary: string;
}

function statusVariant(s: string) {
  switch (s) {
    case "proposed":
      return "warning" as const;
    case "approved":
    case "executed":
      return "success" as const;
    case "rejected":
      return "error" as const;
    case "rolled_back":
      return "default" as const;
    default:
      return "default" as const;
  }
}

function executionStatusVariant(s: string) {
  switch (s) {
    case "failed":
      return "error" as const;
    case "succeeded":
      return "success" as const;
    case "running":
      return "warning" as const;
    default:
      return "default" as const;
  }
}

function toLabel(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export default function ActionsPage() {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [offset, setOffset] = useState(0);
  const [targetActionId, setTargetActionId] = useState<string | null>(null);
  const limit = 25;

  const queryParts: string[] = [`limit=${limit}`, `offset=${offset}`];
  if (statusFilter !== "all") queryParts.push(`status=${statusFilter}`);
  const query = queryParts.join("&");

  const { data, error, isLoading, mutate } = useActions(query);
  const { data: targetData } = useAction(targetActionId);
  const response = data as ActionsListResponse | undefined;
  const targetAction = targetData as ActionResponse | undefined;

  useEffect(() => {
    const syncTargetFromHash = () => {
      const hash = window.location.hash;
      if (!hash.startsWith("#action-")) {
        setTargetActionId(null);
        return;
      }

      const id = hash.slice("#action-".length).trim();
      setTargetActionId(id.length > 0 ? id : null);
    };

    syncTargetFromHash();
    window.addEventListener("hashchange", syncTargetFromHash);
    return () => {
      window.removeEventListener("hashchange", syncTargetFromHash);
    };
  }, []);

  const linkedActionOutsideCurrentPage =
    !!response && !!targetAction && !response.actions.some((a) => a.id === targetAction.id);

  const renderedActions = useMemo(() => {
    if (!response) return [] as ActionItemResponse[];
    if (!targetAction) return response.actions;
    if (response.actions.some((a) => a.id === targetAction.id)) return response.actions;
    return [targetAction, ...response.actions];
  }, [response, targetAction]);

  const handleAction = async (id: string, type: "approve" | "reject" | "retry-execution") => {
    try {
      await apiFetch(`/api/actions/${id}/${type}`, { method: "POST" });
      mutate();
    } catch {
      // Error will be reflected on next poll
    }
  };

  return (
    <div className="space-y-6 md:space-y-7 lg:space-y-8 motion-page-enter">
      {/* Header */}
      <div className="space-y-2 motion-rise-in">
        <p className="page-eyebrow">
          Operational Hub
        </p>
        <h1 className="page-title">
          Action Center
        </h1>
        <p className="page-copy">
          Review, validate, and execute agent-proposed actions.
        </p>
      </div>

      {/* Status filter */}
      <div className={`motion-rise-in-soft overflow-x-auto pb-1 ${getMotionDelayClass(1)}`}>
        <div className="flex gap-1">
          {STATUS_OPTIONS.map((s) => (
            <button
              key={s}
              onClick={() => { setStatusFilter(s); setOffset(0); }}
              className={`filter-chip ${
                statusFilter === s
                  ? "filter-chip-active"
                  : "filter-chip-idle"
              }`}
            >
              {s === "all" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* List */}
      {isLoading && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Card key={i}>
              <div className="state-skeleton h-24" />
            </Card>
          ))}
        </div>
      )}

      {error && (
        <Card>
          <CardContent className="state-content state-content-center py-8">
            <AlertTriangle className="h-8 w-8 text-red-500/80 dark:text-red-400/80" />
            <p className="state-error">Failed to load actions.</p>
          </CardContent>
        </Card>
      )}

      {response && (
        <>
          {renderedActions.length === 0 ? (
            <Card>
              <CardContent className="state-content state-content-center py-10">
                <Zap className="state-icon" />
                <p className="state-title">
                  No actions match your filters.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3 md:space-y-4">
              {linkedActionOutsideCurrentPage && (
                <Card className="border-amber-500/35 bg-amber-500/10 dark:border-amber-400/40 dark:bg-amber-500/15">
                  <CardContent className="py-3 text-label-sm text-amber-900 dark:text-amber-100">
                    Linked action loaded outside current page/filter.
                  </CardContent>
                </Card>
              )}

              {renderedActions.map((action, index) => {
                const parsedPayload = parsePayload(action.payloadJson);
                const context = deriveActionContext(action.actionType, parsedPayload);

                return (
                  <Card
                    key={action.id}
                    id={`action-${action.id}`}
                    className={`motion-rise-in-soft ${getMotionDelayClass(index + 2)} ${
                      action.id === targetActionId
                        ? "ring-1 ring-amber-500/45 dark:ring-amber-300/45"
                        : ""
                    }`}
                  >
                    <CardHeader>
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <CardTitle className="flex items-center gap-2">
                          <Zap className="h-4 w-4" />
                          {toLabel(action.actionType)}
                        </CardTitle>
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant={statusVariant(action.status)}>
                            Lifecycle: {toLabel(action.status)}
                          </Badge>
                          <Badge variant={executionStatusVariant(action.executionStatus)}>
                            Execution: {toLabel(action.executionStatus)}
                          </Badge>
                          {action.riskLevel === "approval_required" && (
                            <Badge variant="warning">Risk: Approval Required</Badge>
                          )}
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="rounded-eight border border-outline-variant/35 bg-surface-low p-4 dark:border-dark-outline-variant/35 dark:bg-dark-surface-low">
                        <p className="panel-eyebrow">Action Context</p>
                        <div className="space-y-1">
                          <p className="text-sm text-on-surface dark:text-dark-on-surface">
                            <span className="font-semibold">Sender:</span> {action.itemFrom ?? "Unknown sender"}
                          </p>
                          <p className="text-sm text-on-surface dark:text-dark-on-surface">
                            <span className="font-semibold">Subject:</span> {action.itemSubject ?? "No subject captured"}
                          </p>
                          <p className="text-sm text-on-surface dark:text-dark-on-surface">
                            <span className="font-semibold">Source:</span> {action.itemSource ? toLabel(action.itemSource) : "Unknown source"}
                          </p>
                          <p className="text-sm text-on-surface dark:text-dark-on-surface">
                            <span className="font-semibold">Rule:</span> {context.ruleName}
                          </p>
                          <p className="text-sm text-on-surface dark:text-dark-on-surface">
                            <span className="font-semibold">Why:</span> {context.reasonSummary}
                          </p>
                          {context.reasonCode && (
                            <p className="text-label-sm text-on-surface-variant dark:text-dark-on-surface-variant">
                              Reason Code: {context.reasonCode}
                            </p>
                          )}
                        </div>
                      </div>

                      <div className="rounded-eight bg-surface-low p-4 dark:bg-dark-surface-low">
                        <p className="panel-eyebrow">
                          Payload
                        </p>
                        <pre className="text-sm meta-copy overflow-x-auto whitespace-pre-wrap">
                          {formatPayload(action.payloadJson, parsedPayload)}
                        </pre>
                      </div>
                      {action.executionStatus === "failed" && action.errorJson && (
                        <div className="rounded-eight border border-red-500/20 bg-red-500/10 p-4 dark:border-red-400/25 dark:bg-red-500/15">
                          <p className="panel-eyebrow text-red-700 dark:text-red-300">
                            Execution Error
                          </p>
                          <pre className="text-sm text-red-700/90 dark:text-red-200 overflow-x-auto whitespace-pre-wrap">
                            {formatPayload(action.errorJson)}
                          </pre>
                        </div>
                      )}
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <p className="text-label-sm meta-copy">
                          Created{" "}
                          {new Date(action.createdAt).toLocaleString("en-US", {
                            month: "short",
                            day: "numeric",
                            hour: "numeric",
                            minute: "2-digit",
                          })}
                        </p>
                        {action.status === "proposed" && (
                          <div className="flex w-full gap-2 sm:w-auto">
                            <Button
                              variant="secondary"
                              size="sm"
                              className="flex-1 sm:flex-none"
                              onClick={() => handleAction(action.id, "reject")}
                            >
                              <X className="h-4 w-4" />
                              Reject
                            </Button>
                            <Button
                              variant="primary"
                              size="sm"
                              className="flex-1 sm:flex-none"
                              onClick={() => handleAction(action.id, "approve")}
                            >
                              <Check className="h-4 w-4" />
                              Confirm Execution
                            </Button>
                          </div>
                        )}
                        {action.status === "approved" && action.executionStatus === "failed" && (
                          <div className="flex w-full gap-2 sm:w-auto">
                            <Button
                              variant="primary"
                              size="sm"
                              className="flex-1 sm:flex-none"
                              onClick={() => handleAction(action.id, "retry-execution")}
                            >
                              Retry Execution
                            </Button>
                          </div>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}

          {/* Pagination */}
          <div
            className={`motion-rise-in-soft flex flex-col gap-3 pt-4 sm:flex-row sm:items-center sm:justify-between ${getMotionDelayClass(3)}`}
          >
            <p className="text-label-md meta-copy">
              Showing {response.pagination.total === 0 ? 0 : offset + 1}–{Math.min(offset + limit, response.pagination.total)} of{" "}
              {response.pagination.total}
            </p>
            <div className="flex w-full gap-2 sm:w-auto">
              <Button
                variant="secondary"
                size="sm"
                className="flex-1 sm:flex-none"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - limit))}
              >
                Previous
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className="flex-1 sm:flex-none"
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

function parsePayload(json: string): ParsedPayload {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function deriveActionContext(actionType: string, payload: ParsedPayload): ActionContextSummary {
  const reasonCode = readPayloadString(payload, "reason");
  if (reasonCode) {
    const known = REASON_DETAILS[reasonCode];
    if (known) {
      return {
        ruleName: known.ruleName,
        reasonCode,
        reasonSummary: known.summary,
      };
    }

    const humanReason = toLabel(reasonCode);
    return {
      ruleName: `${humanReason} Rule`,
      reasonCode,
      reasonSummary: `Triggered by ${humanReason.toLowerCase()}.`,
    };
  }

  return {
    ruleName: ACTION_FALLBACK_RULES[actionType] ?? `${toLabel(actionType)} Policy`,
    reasonCode: null,
    reasonSummary: "No explicit reason code was recorded for this action.",
  };
}

function readPayloadString(payload: ParsedPayload, key: string): string | null {
  if (!payload) return null;
  const value = payload[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function formatPayload(json: string, parsedPayload?: ParsedPayload): string {
  if (parsedPayload) {
    return JSON.stringify(parsedPayload, null, 2);
  }

  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}
