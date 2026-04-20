"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { useStatus, useNotificationPreferences } from "@/lib/hooks";
import { apiFetch } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Wifi,
  WifiOff,
  Mail,
  GitBranch,
  CalendarDays,
  Brain,
  Bell,
  ExternalLink,
  Trash2,
  Loader2,
} from "lucide-react";

interface Integration {
  name: string;
  connected: boolean;
  source?: "db" | "env" | "none";
  connectedAs?: string | null;
  detail?: string;
}

interface StatusResponse {
  integrations: Integration[];
  uptime: number;
}

const integrationIcons: Record<string, typeof Mail> = {
  gmail: Mail,
  github: GitBranch,
  calendar: CalendarDays,
  llm: Brain,
  notifications: Bell,
};

export default function SettingsPage() {
  const { data: session } = useSession();
  const userId = session?.user?.email ?? "";
  const { data: statusData, isLoading: statusLoading, mutate: mutateStatus } = useStatus();
  const { data: prefsData } = useNotificationPreferences();
  const status = statusData as StatusResponse | undefined;

  const [githubPat, setGithubPat] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const gmail = status?.integrations.find((i) => i.name === "gmail");
  const github = status?.integrations.find((i) => i.name === "github");

  async function connectGoogle() {
    setBusy("google");
    setError(null);
    try {
      const data = await apiFetch<{ url: string }>(`/api/oauth/start/google?userId=${userId}&returnTo=/settings`);
      window.location.href = data.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start Google OAuth");
      setBusy(null);
    }
  }

  async function disconnectGoogle() {
    setBusy("google-disconnect");
    setError(null);
    try {
      await apiFetch("/api/oauth/disconnect/google", {
        method: "POST",
        body: JSON.stringify({ userId }),
      });
      setSuccess("Google disconnected");
      await mutateStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to disconnect Google");
    } finally {
      setBusy(null);
    }
  }

  async function connectGithub() {
    if (!githubPat.trim()) return;
    setBusy("github");
    setError(null);
    try {
      const data = await apiFetch<{ connected: boolean; login: string; email: string | null }>("/api/integrations/github/connect", {
        method: "POST",
        body: JSON.stringify({ token: githubPat.trim(), userId }),
      });
      setSuccess(`GitHub connected as ${data.login}`);
      setGithubPat("");
      await mutateStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect GitHub");
    } finally {
      setBusy(null);
    }
  }

  async function disconnectGithub() {
    setBusy("github-disconnect");
    setError(null);
    try {
      await apiFetch("/api/integrations/github/disconnect", {
        method: "POST",
        body: JSON.stringify({ userId }),
      });
      setSuccess("GitHub disconnected");
      await mutateStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to disconnect GitHub");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="space-y-2">
        <p className="text-label-md uppercase tracking-wider text-on-surface-variant/50 dark:text-dark-on-surface-variant/50">
          Configuration
        </p>
        <h1 className="text-display-md font-bold text-on-surface dark:text-dark-on-surface">
          Settings
        </h1>
      </div>

      {/* Flash messages */}
      {error && (
        <div className="rounded-eight border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">
          {error}
        </div>
      )}
      {success && (
        <div className="rounded-eight border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-400">
          {success}
        </div>
      )}

      {/* Google Connection */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5" />
            Google (Gmail &amp; Calendar)
          </CardTitle>
        </CardHeader>
        <CardContent>
          {statusLoading ? (
            <div className="h-12 animate-pulse rounded-eight bg-surface-low dark:bg-dark-surface-low" />
          ) : gmail?.connected && gmail.source === "db" ? (
            <div className="flex items-center justify-between">
              <div>
                <Badge variant="success">Connected via OAuth</Badge>
                {gmail.connectedAs && (
                  <p className="mt-1 text-sm text-on-surface-variant dark:text-dark-on-surface-variant">
                    {gmail.connectedAs}
                  </p>
                )}
              </div>
              <button
                onClick={disconnectGoogle}
                disabled={busy === "google-disconnect"}
                className="flex items-center gap-2 rounded-eight px-4 py-2 text-sm font-medium text-red-400 hover:bg-red-500/10 disabled:opacity-50"
              >
                {busy === "google-disconnect" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                Disconnect
              </button>
            </div>
          ) : gmail?.connected && gmail.source === "env" ? (
            <div className="flex items-center justify-between">
              <div>
                <Badge variant="success">Connected via env</Badge>
                <p className="mt-1 text-sm text-on-surface-variant dark:text-dark-on-surface-variant">
                  Configured via environment variables. Connect via OAuth to manage from here.
                </p>
              </div>
              <button
                onClick={connectGoogle}
                disabled={busy === "google"}
                className="flex items-center gap-2 rounded-eight bg-surface-low px-4 py-2 text-sm font-medium text-on-surface hover:bg-surface-low/80 dark:bg-dark-surface-low dark:text-dark-on-surface dark:hover:bg-dark-surface-low/80 disabled:opacity-50"
              >
                {busy === "google" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
                Reconnect via OAuth
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <p className="text-sm text-on-surface-variant dark:text-dark-on-surface-variant">
                Not connected. Sign in with Google to enable Gmail and Calendar.
              </p>
              <button
                onClick={connectGoogle}
                disabled={busy === "google"}
                className="flex items-center gap-2 rounded-eight bg-primary px-4 py-2 text-sm font-medium text-on-primary hover:bg-primary/90 disabled:opacity-50"
              >
                {busy === "google" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
                Connect Google
              </button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* GitHub Connection */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <GitBranch className="h-5 w-5" />
            GitHub
          </CardTitle>
        </CardHeader>
        <CardContent>
          {statusLoading ? (
            <div className="h-12 animate-pulse rounded-eight bg-surface-low dark:bg-dark-surface-low" />
          ) : github?.connected && github.source === "db" ? (
            <div className="flex items-center justify-between">
              <div>
                <Badge variant="success">Connected via PAT</Badge>
                {github.connectedAs && (
                  <p className="mt-1 text-sm text-on-surface-variant dark:text-dark-on-surface-variant">
                    {github.connectedAs}
                  </p>
                )}
              </div>
              <button
                onClick={disconnectGithub}
                disabled={busy === "github-disconnect"}
                className="flex items-center gap-2 rounded-eight px-4 py-2 text-sm font-medium text-red-400 hover:bg-red-500/10 disabled:opacity-50"
              >
                {busy === "github-disconnect" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                Disconnect
              </button>
            </div>
          ) : github?.connected && github.source === "env" ? (
            <div>
              <Badge variant="success">Connected via env</Badge>
              <p className="mt-1 text-sm text-on-surface-variant dark:text-dark-on-surface-variant">
                Configured via GITHUB_TOKEN environment variable.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-on-surface-variant dark:text-dark-on-surface-variant">
                Enter a GitHub Personal Access Token to enable GitHub integration.
              </p>
              <div className="flex gap-2">
                <input
                  type="password"
                  placeholder="ghp_..."
                  value={githubPat}
                  onChange={(e) => setGithubPat(e.target.value)}
                  className="flex-1 rounded-eight border border-outline/20 bg-surface-low px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-variant/40 focus:border-primary focus:outline-none dark:border-dark-outline/20 dark:bg-dark-surface-low dark:text-dark-on-surface dark:placeholder:text-dark-on-surface-variant/40 dark:focus:border-dark-primary"
                />
                <button
                  onClick={connectGithub}
                  disabled={busy === "github" || !githubPat.trim()}
                  className="flex items-center gap-2 rounded-eight bg-primary px-4 py-2 text-sm font-medium text-on-primary hover:bg-primary/90 disabled:opacity-50"
                >
                  {busy === "github" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Connect
                </button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Full Integration Status */}
      <Card>
        <CardHeader>
          <CardTitle>All Integrations</CardTitle>
        </CardHeader>
        <CardContent>
          {statusLoading ? (
            <div className="animate-pulse space-y-4">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-12 rounded-eight bg-surface-low dark:bg-dark-surface-low" />
              ))}
            </div>
          ) : status ? (
            <div className="space-y-3">
              {status.integrations.map((integration) => {
                const Icon = integrationIcons[integration.name] ?? Wifi;
                return (
                  <div
                    key={integration.name}
                    className="flex items-center justify-between rounded-eight p-4 bg-surface-low dark:bg-dark-surface-low"
                  >
                    <div className="flex items-center gap-3">
                      <Icon className="h-5 w-5 text-on-surface-variant dark:text-dark-on-surface-variant" />
                      <div>
                        <p className="font-medium capitalize text-on-surface dark:text-dark-on-surface">
                          {integration.name}
                        </p>
                        {integration.detail && (
                          <p className="text-label-md text-on-surface-variant dark:text-dark-on-surface-variant">
                            {integration.detail}
                            {integration.connectedAs ? ` · ${integration.connectedAs}` : ""}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {integration.connected ? (
                        <>
                          <Wifi className="h-4 w-4 text-emerald-500" />
                          <Badge variant="success">Connected</Badge>
                        </>
                      ) : (
                        <>
                          <WifiOff className="h-4 w-4 text-on-surface-variant/40 dark:text-dark-on-surface-variant/40" />
                          <Badge>Disconnected</Badge>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
              <div className="pt-2">
                <p className="text-label-sm text-on-surface-variant/50 dark:text-dark-on-surface-variant/50">
                  Uptime: {formatUptime(status.uptime)}
                </p>
              </div>
            </div>
          ) : (
            <p className="text-on-surface-variant dark:text-dark-on-surface-variant">
              Unable to load status
            </p>
          )}
        </CardContent>
      </Card>

      {/* Notification Preferences */}
      <Card>
        <CardHeader>
          <CardTitle>Notification Preferences</CardTitle>
        </CardHeader>
        <CardContent>
          {prefsData ? (
            <pre className="rounded-eight bg-surface-low p-4 text-sm text-on-surface-variant overflow-x-auto dark:bg-dark-surface-low dark:text-dark-on-surface-variant">
              {JSON.stringify(prefsData, null, 2)}
            </pre>
          ) : (
            <p className="text-on-surface-variant dark:text-dark-on-surface-variant">
              Loading preferences...
            </p>
          )}
        </CardContent>
      </Card>

      {/* Theme info */}
      <Card>
        <CardHeader>
          <CardTitle>Theme</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-on-surface-variant dark:text-dark-on-surface-variant">
            Dark mode is currently the default. Theme switching will be available in a future update.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
