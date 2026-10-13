"use client";

import Link from "next/link";
import useSWR from "swr";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiError, apiFetch } from "@/lib/api";

interface RollupMetrics {
  modelCalls: number;
  modelDenials: number;
  actionsByStatus: Record<string, number>;
  activeGrants: number;
}

interface PlatformTenant {
  id: string;
  tenantSlug: string;
  displayName: string;
  origin: string;
  enrolledAt: string;
  latestRollup: { day: string; metrics: RollupMetrics } | null;
}

const totalActions = (byStatus: Record<string, number>) => Object.values(byStatus).reduce((sum, n) => sum + n, 0);

export default function PlatformPage() {
  const { data, error } = useSWR<{ tenants: PlatformTenant[] }>(
    "/api/platform/tenants",
    (path: string) => apiFetch<{ tenants: PlatformTenant[] }>(path, undefined, { redirectOnAuth: false }),
  );

  if (error instanceof ApiError && error.status === 403) {
    return <p className="state-error">This page is for platform operators.</p>;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Enrolled pharmacies</CardTitle>
        <p className="text-label-sm meta-copy">
          Counts only, from the latest daily rollup. <Link href="/platform/enrol" className="underline">Enrol a pharmacy</Link>
        </p>
      </CardHeader>
      <CardContent>
        {error ? (
          <p className="state-error">Could not load the pharmacies.</p>
        ) : !data ? (
          <div className="state-skeleton h-12" />
        ) : data.tenants.length === 0 ? (
          <p className="text-sm meta-copy">None yet.</p>
        ) : (
          <ul className="space-y-3">
            {data.tenants.map((t) => (
              <li key={t.id} className="text-sm">
                <div>
                  {t.displayName} <span className="meta-copy">({t.tenantSlug}, {t.origin})</span>
                </div>
                {t.latestRollup ? (
                  <div className="meta-copy">
                    {t.latestRollup.day}: {t.latestRollup.metrics.modelCalls} model calls ({t.latestRollup.metrics.modelDenials} denied),{" "}
                    {totalActions(t.latestRollup.metrics.actionsByStatus)} actions, {t.latestRollup.metrics.activeGrants} active grants
                  </div>
                ) : (
                  <div className="meta-copy">No rollup yet.</div>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
