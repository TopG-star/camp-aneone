"use client";

import type { LegacyActionListResponse } from "@oneon/contracts";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useLegacyActions } from "@/lib/hooks";

export function LegacyList({ query }: { query: string }) {
  const { data, isLoading } = useLegacyActions(query);
  const response = data as LegacyActionListResponse | undefined;
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
    </div>
  );
}
