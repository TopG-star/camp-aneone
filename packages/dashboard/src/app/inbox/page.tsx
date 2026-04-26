"use client";

import { useState } from "react";
import { useInbox } from "@/lib/hooks";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Mail, GitBranch, MessageSquare, Filter } from "lucide-react";
import type { InboxListResponse } from "@oneon/contracts";
import { getMotionDelayClass } from "@/lib/motion-utils";

const sourceIcons: Record<string, typeof Mail> = {
  gmail: Mail,
  github: GitBranch,
  teams: MessageSquare,
};

const SOURCE_OPTIONS = ["all", "gmail", "github", "teams"] as const;
const CATEGORY_OPTIONS = [
  "all",
  "action_needed",
  "informational",
  "follow_up",
  "low_priority",
] as const;

function priorityVariant(p: number) {
  if (p <= 1) return "error" as const;
  if (p <= 2) return "warning" as const;
  return "default" as const;
}

export default function InboxPage() {
  const [source, setSource] = useState<string>("all");
  const [category, setCategory] = useState<string>("all");
  const [offset, setOffset] = useState(0);
  const limit = 25;

  const queryParts: string[] = [`limit=${limit}`, `offset=${offset}`];
  if (source !== "all") queryParts.push(`source=${source}`);
  if (category !== "all") queryParts.push(`category=${category}`);
  const query = queryParts.join("&");

  const { data, error, isLoading } = useInbox(query);
  const response = data as InboxListResponse | undefined;

  return (
    <div className="space-y-6 md:space-y-7 lg:space-y-8 motion-page-enter">
      {/* Header */}
      <div className="space-y-2 motion-rise-in">
        <p className="page-eyebrow">
          Intelligence
        </p>
        <h1 className="page-title">
          Inbox
        </h1>
        <p className="page-copy">
          All signals from connected sources, classified by the agent.
        </p>
      </div>

      {/* Filters */}
      <div className={`motion-rise-in-soft space-y-2 ${getMotionDelayClass(1)}`}>
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-on-surface-variant dark:text-dark-on-surface-variant" />
          <span className="text-label-sm text-on-surface-variant dark:text-dark-on-surface-variant">
            Filters
          </span>
        </div>

        <div className="flex gap-1 overflow-x-auto pb-1">
          {SOURCE_OPTIONS.map((s) => (
            <button
              key={s}
              onClick={() => { setSource(s); setOffset(0); }}
              className={`filter-chip ${
                source === s
                  ? "filter-chip-active"
                  : "filter-chip-idle"
              }`}
            >
              {s === "all" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>

        <div className="flex gap-1 overflow-x-auto pb-1">
          {CATEGORY_OPTIONS.map((c) => (
            <button
              key={c}
              onClick={() => { setCategory(c); setOffset(0); }}
              className={`filter-chip ${
                category === c
                  ? "filter-chip-active"
                  : "filter-chip-idle"
              }`}
            >
              {c === "all" ? "All" : c.replace(/_/g, " ")}
            </button>
          ))}
        </div>
      </div>

      {/* List */}
      {isLoading && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="animate-pulse">
              <div className="h-20" />
            </Card>
          ))}
        </div>
      )}

      {error && (
        <Card>
          <CardContent>
            <p className="text-red-500">Failed to load inbox.</p>
          </CardContent>
        </Card>
      )}

      {response && (
        <>
          {response.items.length === 0 ? (
            <Card>
              <CardContent>
                <p className="text-on-surface-variant dark:text-dark-on-surface-variant">
                  No items match your filters.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-2 md:space-y-3">
              {response.items.map((item, index) => {
                const Icon = sourceIcons[item.source] ?? Mail;
                return (
                  <Card
                    key={item.id}
                    className={`group motion-interactive motion-rise-in-soft cursor-pointer transition-colors hover:bg-surface-low dark:hover:bg-dark-surface-high ${getMotionDelayClass(index + 2)}`}
                  >
                    <CardContent className="flex items-start gap-4">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-eight bg-surface-high dark:bg-dark-surface-high">
                        <Icon className="h-5 w-5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
                          <p className="truncate font-medium text-on-surface dark:text-dark-on-surface">
                            {item.subject}
                          </p>
                          <div className="flex items-center gap-2">
                            {item.classification && (
                              <Badge variant={priorityVariant(item.classification.priority)}>
                                P{item.classification.priority}
                              </Badge>
                            )}
                            <span className="text-label-sm meta-copy">
                              {new Date(item.receivedAt).toLocaleDateString("en-US", {
                                month: "short",
                                day: "numeric",
                              })}
                            </span>
                          </div>
                        </div>
                        <p className="text-sm meta-copy">
                          {item.from}
                        </p>
                        {item.classification && (
                          <p className="mt-1 text-sm meta-copy">
                            {item.classification.summary}
                          </p>
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
              Showing {offset + 1}–{Math.min(offset + limit, response.pagination.total)} of{" "}
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
