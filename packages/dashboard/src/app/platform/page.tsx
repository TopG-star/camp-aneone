"use client";

import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ApiError, apiFetch } from "@/lib/api";
import {
  impressorxTenantIdText,
  registrationAction,
  registrationStatusText,
  resumeConfirmation,
  suspendConfirmation,
  type RegistrationStatus,
} from "@/lib/platform-ui";

interface RollupMetrics {
  modelCalls: number;
  modelDenials: number;
  actionsByStatus: Record<string, number>;
  activeGrants: number;
}

interface PlatformTenant {
  id: string;
  tenantSlug: string;
  impressorxTenantId: string;
  displayName: string;
  origin: string;
  enrolledAt: string;
  status: RegistrationStatus;
  latestRollup: { day: string; metrics: RollupMetrics } | null;
}

const WARNING_BOX =
  "mt-2 rounded-eight border border-amber-500/35 bg-amber-500/10 p-3 text-sm text-amber-900 dark:border-amber-400/40 dark:bg-amber-500/15 dark:text-amber-100";

const totalActions = (byStatus: Record<string, number>) => Object.values(byStatus).reduce((sum, n) => sum + n, 0);

export default function PlatformPage() {
  const { data, error, mutate } = useSWR<{ tenants: PlatformTenant[] }>(
    "/api/platform/tenants",
    (path: string) => apiFetch<{ tenants: PlatformTenant[] }>(path, undefined, { redirectOnAuth: false }),
  );
  // One change at a time. `asking` is the pharmacy waiting for its "are you sure".
  const [asking, setAsking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  if (error instanceof ApiError && error.status === 403) {
    return <p className="state-error">This page is for platform operators.</p>;
  }

  const change = async (tenant: PlatformTenant, action: "suspend" | "resume") => {
    setBusy(true);
    setMessage(null);
    try {
      await apiFetch(`/api/platform/registrations/${tenant.id}/${action}`, { method: "POST" }, { redirectOnAuth: false });
      setMessage({ kind: "ok", text: action === "suspend" ? `Suspended ${tenant.displayName}.` : `Resumed ${tenant.displayName}.` });
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : "That didn't work. Try again." });
    } finally {
      setAsking(null);
      setBusy(false);
      await mutate();
    }
  };

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
            {data.tenants.map((t) => {
              const action = registrationAction(t.status);
              return (
                <li key={t.id} className="text-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div>
                        {t.displayName} <span className="meta-copy">({t.tenantSlug}, {t.origin})</span>
                      </div>
                      <div className="meta-copy">{impressorxTenantIdText(t.impressorxTenantId)}</div>
                      <div className={t.status === "active" ? "meta-copy" : "state-error"}>{registrationStatusText(t.status)}</div>
                      {t.latestRollup ? (
                        <div className="meta-copy">
                          {t.latestRollup.day}: {t.latestRollup.metrics.modelCalls} model calls ({t.latestRollup.metrics.modelDenials} denied),{" "}
                          {totalActions(t.latestRollup.metrics.actionsByStatus)} actions, {t.latestRollup.metrics.activeGrants} active grants
                        </div>
                      ) : (
                        <div className="meta-copy">No rollup yet.</div>
                      )}
                    </div>
                    {action && (
                      <Button size="sm" variant="secondary" disabled={busy} onClick={() => setAsking(t.id)}>
                        {action === "suspend" ? "Suspend" : "Resume"}
                      </Button>
                    )}
                  </div>
                  {action && asking === t.id && (
                    <div className={WARNING_BOX}>
                      <p>{action === "suspend" ? suspendConfirmation(t.displayName) : resumeConfirmation(t.displayName)}</p>
                      <div className="mt-2 flex gap-2">
                        <Button size="sm" variant="secondary" disabled={busy} onClick={() => setAsking(null)}>
                          Cancel
                        </Button>
                        <Button size="sm" variant="primary" disabled={busy} onClick={() => change(t, action)}>
                          {action === "suspend" ? "Suspend" : "Resume"}
                        </Button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {message && (
          <p role="status" className={message.kind === "error" ? "state-error mt-3" : "mt-3 text-sm"}>
            {message.text}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
