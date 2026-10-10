"use client";

import { useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import type { ConnectionGrantView, LinkedLoginView, ReconnectActionView, RevokeConnectionResult } from "@oneon/contracts";
import { AlertTriangle, Loader2, Plug } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ApiError, apiFetch } from "@/lib/api";
import { useConnections, useContexts, useLinkedLogins } from "@/lib/hooks";
import { choiceApplied } from "@/lib/context";
import {
  CONNECTIONS_LOAD_FAILED,
  RECONNECT_HELP,
  connectionTitle,
  endsText,
  formatDate,
  kindLabel,
  lastUsedText,
  reconnectLink,
  revokeFailureText,
  revokeNotice,
  revokeWarning,
  scopeText,
  unavailableNote,
  unlinkFailureText,
  unlinkWarning,
  type ReconnectLink,
} from "@/lib/connections-ui";

const WARNING_BOX =
  "mt-2 rounded-eight border border-amber-500/35 bg-amber-500/10 p-3 text-sm text-amber-900 dark:border-amber-400/40 dark:bg-amber-500/15 dark:text-amber-100";

/**
 * Settings → Connections: what Oneon may do at the person's pharmacies (each with a Revoke), the actions waiting for them to
 * reconnect, and the sign-ins that make up their account (each pharmacy one with an Unlink). It works from Personal and from a
 * pharmacy session alike.
 */
export function ConnectionsSettings() {
  const connections = useConnections();
  const logins = useLinkedLogins();
  const contexts = useContexts();
  const { update } = useSession();
  const view = connections.data;
  const loginList = logins.data?.logins;
  // One change at a time: every button is disabled while one runs. `asking` is the row waiting for its "are you sure".
  const [busy, setBusy] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  // What has been done, kept here because a revoked connection leaves the list.
  const [notices, setNotices] = useState<string[]>([]);
  const [error, setError] = useState("");

  async function revoke(grant: ConnectionGrantView) {
    setBusy(grant.id);
    setAsking(null);
    setError("");
    try {
      const result = await apiFetch<RevokeConnectionResult>(`/api/connections/${grant.id}/revoke`, { method: "POST", body: "{}" }, { redirectOnAuth: false });
      setNotices((n) => [...n, `${connectionTitle(grant)}: ${revokeNotice(result.remote, grant.expiresAt)}`]);
      // Revoking this session's own connection ends the session: this refresh then answers 401 and signs the person in again.
      await connections.mutate();
    } catch (err) {
      setError(revokeFailureText(err instanceof ApiError ? err.status : 0));
    } finally {
      setBusy(null);
    }
  }

  async function unlink(login: LinkedLoginView) {
    setBusy(login.id);
    setAsking(null);
    setError("");
    try {
      await apiFetch("/api/identity/unlink", { method: "POST", body: JSON.stringify({ loginIdentityId: login.id }) }, { redirectOnAuth: false });
      setNotices((n) => [...n, `Unlinked ${login.label}.`]);
      await Promise.all([logins.mutate(), connections.mutate()]);
    } catch (err) {
      setError(unlinkFailureText(err instanceof ApiError ? err.status : 0));
    } finally {
      setBusy(null);
    }
  }

  // The same switch the context picker makes (ask the server, then the session), then on to the action in that pharmacy.
  async function switchAndOpen(action: ReconnectActionView, link: Extract<ReconnectLink, { kind: "switch" }>) {
    setBusy(action.actionId);
    setError("");
    try {
      await apiFetch("/api/contexts/validate", { method: "POST", body: JSON.stringify(link.choice) }, { redirectOnAuth: false });
      const updated = await update({ activeContext: link.choice });
      if (!updated || !choiceApplied(updated.activeContext, link.choice)) {
        setError("Your session didn't accept the switch, so you are still in the same context. Please try again.");
        setBusy(null);
        return;
      }
      window.location.assign(link.href);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't switch context");
      setBusy(null);
    }
  }

  const unavailable = view ? unavailableNote(view.unavailable) : null;
  const reconnectLinks = view ? view.needsReconnect.map((action) => reconnectLink(action, contexts.data)) : [];

  return (
    <Card id="connections">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Plug className="h-4 w-4" />
          Connections
        </CardTitle>
        <p className="text-label-sm meta-copy">What Oneon may do for you at your pharmacies. Revoke one and Oneon stops using it straight away.</p>
      </CardHeader>
      <CardContent>
        {!view && connections.error ? (
          <div className="state-content state-content-center py-8">
            <AlertTriangle className="h-8 w-8 text-red-500/80 dark:text-red-400/80" />
            <p className="state-error">{CONNECTIONS_LOAD_FAILED}</p>
          </div>
        ) : !view ? (
          <div className="state-skeleton h-24" />
        ) : (
          <div className="space-y-4">
            {notices.length > 0 && (
              <div role="status" className="space-y-1 text-sm text-on-surface/80 dark:text-dark-on-surface/80">
                {notices.map((notice, i) => (
                  <p key={i}>{notice}</p>
                ))}
              </div>
            )}
            {error && (
              <p role="alert" className="text-label-sm text-red-700 dark:text-red-300">
                {error}
              </p>
            )}

            <section aria-label="Active connections" className="space-y-2">
              {view.grants.length === 0 ? (
                <p className="text-label-sm meta-copy">No active connections.</p>
              ) : (
                view.grants.map((grant) => {
                  const warning = revokeWarning(grant);
                  return (
                    <div key={grant.id} className="rounded-eight bg-surface-low p-3 dark:bg-dark-surface-low">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-semibold text-on-surface dark:text-dark-on-surface">{grant.tenantName}</p>
                            <Badge variant="info">{kindLabel(grant.kind)}</Badge>
                            {grant.current && <Badge variant="default">This session</Badge>}
                          </div>
                          <p className="text-label-sm meta-copy">{scopeText(grant.kind, grant.scope)}</p>
                          <p className="text-label-sm meta-copy">
                            Opened {formatDate(grant.createdAt)} · {lastUsedText(grant.lastUsedAt)} · {endsText(grant.expiresAt)}
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy !== null}
                          aria-label={`Revoke ${connectionTitle(grant)}`}
                          onClick={() => (warning ? setAsking(grant.id) : revoke(grant))}
                        >
                          {busy === grant.id && <Loader2 className="h-4 w-4 animate-spin" />}
                          Revoke
                        </Button>
                      </div>
                      {warning && asking === grant.id && (
                        <div className={WARNING_BOX}>
                          <p>{warning}</p>
                          <div className="mt-2 flex gap-2">
                            <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => setAsking(null)}>
                              Keep it
                            </Button>
                            <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => revoke(grant)}>
                              Revoke and sign out
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </section>

            <section aria-label="Needs reconnect" className="space-y-2">
              <p className="text-sm font-semibold text-on-surface dark:text-dark-on-surface">Needs reconnect</p>
              {view.needsReconnect.length > 0 ? (
                <>
                  {reconnectLinks.some((link) => link.kind !== "reconnect") && <p className="text-label-sm meta-copy">{RECONNECT_HELP}</p>}
                  <ul className="space-y-1">
                    {view.needsReconnect.map((action, i) => {
                      // The action only shows in its own pharmacy: link to it there, offer the switch, or (a session that cannot switch) say how to reconnect.
                      const link = reconnectLinks[i]!;
                      return (
                        <li key={action.actionId} className="text-sm">
                          {link.kind === "open" ? (
                            <Link href={link.href} className="font-medium underline underline-offset-2">
                              {action.label}
                            </Link>
                          ) : (
                            <span className="font-medium">{action.label}</span>
                          )}
                          <span className="meta-copy">
                            {" "}
                            · {action.tenantName} · failed {formatDate(action.failedAt)}
                          </span>
                          {link.kind === "switch" && (
                            <Button size="sm" variant="secondary" className="ml-2" disabled={busy !== null} onClick={() => switchAndOpen(action, link)}>
                              {busy === action.actionId && <Loader2 className="h-4 w-4 animate-spin" />}
                              Switch to {action.tenantName}
                            </Button>
                          )}
                          {link.kind === "reconnect" && <p className="text-label-sm meta-copy">{RECONNECT_HELP}</p>}
                        </li>
                      );
                    })}
                  </ul>
                </>
              ) : (
                !unavailable && <p className="text-label-sm meta-copy">Nothing is waiting for you to reconnect.</p>
              )}
              {unavailable && <p className="text-label-sm text-amber-800 dark:text-amber-300">{unavailable}</p>}
            </section>

            <section aria-label="Linked logins" className="space-y-2">
              <p className="text-sm font-semibold text-on-surface dark:text-dark-on-surface">Linked logins</p>
              {!loginList && logins.error ? (
                <p className="state-error">Couldn&apos;t load your linked sign-ins.</p>
              ) : !loginList ? (
                <div className="state-skeleton h-12" />
              ) : (
                loginList.map((login) => {
                  const onlyOne = loginList.length < 2;
                  return (
                    <div key={login.id} className="rounded-eight bg-surface-low p-3 dark:bg-dark-surface-low">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="default">{login.kind === "google" ? "Google" : "ImpressoRx"}</Badge>
                          <p className="text-sm text-on-surface dark:text-dark-on-surface">{login.label}</p>
                        </div>
                        {login.kind === "impressorx" && (
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={busy !== null || onlyOne}
                            aria-label={`Unlink ${login.label}`}
                            title={onlyOne ? "This is the only sign-in on your account" : undefined}
                            onClick={() => setAsking(login.id)}
                          >
                            {busy === login.id && <Loader2 className="h-4 w-4 animate-spin" />}
                            Unlink
                          </Button>
                        )}
                      </div>
                      {asking === login.id && (
                        <div className={WARNING_BOX}>
                          <p>{unlinkWarning(login)}</p>
                          <div className="mt-2 flex gap-2">
                            <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => setAsking(null)}>
                              Keep it linked
                            </Button>
                            <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => unlink(login)}>
                              Unlink
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </section>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
