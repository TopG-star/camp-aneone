"use client";

import { useState } from "react";
import useSWR from "swr";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ApiError, apiFetch } from "@/lib/api";

interface Registration {
  id: string;
  tenantSlug: string;
  displayName: string;
  origin: string;
  enrolledAt: string;
}

const FIELD = "w-full rounded-eight border border-border bg-transparent px-3 py-2 text-sm";

export default function EnrolTenantPage() {
  const [origin, setOrigin] = useState("");
  const [tenantSlug, setTenantSlug] = useState("");
  const [code, setCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const { data, error, mutate } = useSWR<{ registrations: Registration[] }>(
    "/api/platform/registrations",
    (path: string) => apiFetch<{ registrations: Registration[] }>(path, undefined, { redirectOnAuth: false }),
  );

  const forbidden = error instanceof ApiError && error.status === 403;

  const enrol = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const result = await apiFetch<{ reenrolled?: boolean }>(
        "/api/platform/enrolments",
        {
          method: "POST",
          body: JSON.stringify({ origin: origin.trim(), tenantSlug: tenantSlug.trim(), code: code.trim(), ...(displayName.trim() ? { displayName: displayName.trim() } : {}) }),
        },
        { redirectOnAuth: false },
      );
      setCode("");
      setMessage({
        kind: "ok",
        text: result?.reenrolled
          ? `Enrolled ${tenantSlug.trim()} again: its keys were replaced and its grants revoked. Staff open Oneon from ImpressoRx again to reconnect.`
          : `Enrolled ${tenantSlug.trim()}.`,
      });
      await mutate();
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : "Enrolment failed" });
    } finally {
      setBusy(false);
    }
  };

  const rotate = async (registration: Registration) => {
    setBusy(true);
    setMessage(null);
    try {
      await apiFetch(`/api/platform/registrations/${registration.id}/rotate-key`, { method: "POST" }, { redirectOnAuth: false });
      setMessage({ kind: "ok", text: `Rotated Oneon's signing key for ${registration.tenantSlug}. The old key works for 7 days.` });
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : "Key rotation failed" });
    } finally {
      setBusy(false);
    }
  };

  if (forbidden) {
    return <p className="state-error">This page is for platform operators.</p>;
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Enrol a pharmacy</CardTitle>
          <p className="text-label-sm meta-copy">
            Before you enrol, check the origin against the tenant registry. Enrolment trusts whichever deployment answers at this address and holds the code.
            To reconnect a pharmacy you suspended, enrol it again here with a fresh code, at the same origin.
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={enrol} className="space-y-3">
            <label className="block text-sm">
              HTTPS origin
              <input className={FIELD} type="url" required placeholder="https://pharmacy.example" value={origin} onChange={(e) => setOrigin(e.target.value)} />
            </label>
            <label className="block text-sm">
              Tenant slug
              <input className={FIELD} required pattern="[a-z0-9][a-z0-9-]*" placeholder="acme-pharmacy" value={tenantSlug} onChange={(e) => setTenantSlug(e.target.value)} />
            </label>
            <label className="block text-sm">
              Enrolment code
              <input className={FIELD} required autoComplete="off" placeholder="ABCD-EFGH-…" value={code} onChange={(e) => setCode(e.target.value)} />
            </label>
            <label className="block text-sm">
              Display name (optional)
              <input className={FIELD} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </label>
            <Button type="submit" variant="primary" disabled={busy}>Enrol</Button>
            {message && (
              <p role="status" className={message.kind === "error" ? "state-error" : "text-sm"}>
                {message.text}
              </p>
            )}
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Enrolled pharmacies</CardTitle>
        </CardHeader>
        <CardContent>
          {!data ? (
            <div className="state-skeleton h-12" />
          ) : data.registrations.length === 0 ? (
            <p className="text-sm meta-copy">None yet.</p>
          ) : (
            <ul className="space-y-2">
              {data.registrations.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 text-sm">
                  <span>
                    {r.displayName} <span className="meta-copy">({r.tenantSlug}, {r.origin})</span>
                  </span>
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => rotate(r)}>Rotate signing key</Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
