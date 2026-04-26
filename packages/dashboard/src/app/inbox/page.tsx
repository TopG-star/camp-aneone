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
    <div className="space-y-8 motion-page-enter">
      {/* Header */}
      <div className="space-y-2 motion-rise-in">
        <p className="text-label-md uppercase tracking-wider text-on-surface-variant/50 dark:text-dark-on-surface-variant/50">
          Intelligence
        </p>
        <h1 className="text-display-md font-bold text-on-surface dark:text-dark-on-surface">
          Inbox
        </h1>
        <p className="text-on-surface-variant dark:text-dark-on-surface-variant">
          All signals from connected sources, classified by the agent.
        </p>
      </div>

      {/* Filters */}
      <div className={`motion-rise-in-soft flex flex-wrap items-center gap-3 ${getMotionDelayClass(1)}`}>
        <Filter className="h-4 w-4 text-on-surface-variant dark:text-dark-on-surface-variant" />
        <div className="flex gap-1">
          {SOURCE_OPTIONS.map((s) => (
            <button
              key={s}
              onClick={() => { setSource(s); setOffset(0); }}
              className={`rounded-full px-3 py-1 text-label-md font-medium transition-colors ${
                source === s
                  ? "bg-primary text-on-primary dark:bg-dark-primary dark:text-dark-on-primary"
                  : "text-on-surface-variant hover:bg-surface-high dark:text-dark-on-surface-variant dark:hover:bg-dark-surface-high"
              }`}
            >
              {s === "all" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
        <span className="text-on-surface-variant/30 dark:text-dark-on-surface-variant/30">
          |
        </span>
        <div className="flex gap-1">
          {CATEGORY_OPTIONS.map((c) => (
            <button
              key={c}
              onClick={() => { setCategory(c); setOffset(0); }}
              className={`rounded-full px-3 py-1 text-label-md font-medium transition-colors ${
                category === c
                  ? "bg-primary text-on-primary dark:bg-dark-primary dark:text-dark-on-primary"
                  : "text-on-surface-variant hover:bg-surface-high dark:text-dark-on-surface-variant dark:hover:bg-dark-surface-high"
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
            <div className="space-y-2">
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
                        <div className="flex items-center justify-between gap-4">
                          <p className="truncate font-medium text-on-surface dark:text-dark-on-surface">
                            {item.subject}
                          </p>
                          <div className="flex items-center gap-2 shrink-0">
                            {item.classification && (
                              <Badge variant={priorityVariant(item.classification.priority)}>
                                P{item.classification.priority}
                              </Badge>
                            )}
                            <span className="text-label-sm text-on-surface-variant/50 dark:text-dark-on-surface-variant/50">
                              {new Date(item.receivedAt).toLocaleDateString("en-US", {
                                month: "short",
                                day: "numeric",
                              })}
                            </span>
                          </div>
                        </div>
                        <p className="text-sm text-on-surface-variant dark:text-dark-on-surface-variant">
                          {item.from}
                        </p>
                        {item.classification && (
                          <p className="mt-1 text-sm text-on-surface-variant/70 dark:text-dark-on-surface-variant/70">
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
          <div className={`motion-rise-in-soft flex items-center justify-between pt-4 ${getMotionDelayClass(3)}`}>
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
