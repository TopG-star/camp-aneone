"use client";

import type { LegacyActionListResponse } from "@oneon/contracts";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle } from "lucide-react";
import { useLegacyActions } from "@/lib/hooks";
import { Pager } from "@/components/actions/pager";

export function LegacyList({ query, onOffsetChange }: { query: string; onOffsetChange: (offset: number) => void }) {
  const { data, error, isLoading } = useLegacyActions(query);
  const response = data as LegacyActionListResponse | undefined;
  if (error && !response) {
    return (
      <Card>
        <CardContent className="state-content state-content-center py-8">
          <AlertTriangle className="h-8 w-8 text-red-500/80 dark:text-red-400/80" />
          <p className="state-error">Failed to load MVP1 actions.</p>
        </CardContent>
      </Card>
    );
  }
  if (isLoading || !response) return <div className="state-skeleton h-24" />;
  return (
    <div className="space-y-3">
      <Card className="border-amber-500/35 bg-amber-500/10 dark:border-amber-400/40 dark:bg-amber-500/15">
        <CardContent className="py-3 text-label-sm text-amber-900 dark:text-amber-100">{response.banner}</CardContent>
      </Card>
      {response.actions.length === 0 ? (
        <p className="state-title">No MVP1 actions to show.</p>
      ) : (
        response.actions.map((a) => (
          <Card key={a.id}>
            <CardContent className="flex flex-col gap-1 py-4">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-on-surface dark:text-dark-on-surface">{a.actionType.replace(/_/g, " ")}</p>
                <Badge variant="default">{a.status.replace(/_/g, " ")} (MVP1)</Badge>
              </div>
              <p className="text-label-sm meta-copy">{new Date(a.createdAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}</p>
            </CardContent>
          </Card>
        ))
      )}
      <Pager pagination={response.pagination} onOffsetChange={onOffsetChange} />
    </div>
  );
}
