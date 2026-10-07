"use client";

import useSWR, { type SWRConfiguration } from "swr";
import type { UserProfileResponse } from "@oneon/contracts";
import { apiFetch } from "@/lib/api";

function fetcher<T>(path: string): Promise<T> {
  return apiFetch<T>(path);
}

/** Today aggregated data — refresh every 60s */
export function useToday(config?: SWRConfiguration) {
  return useSWR("/api/today", fetcher, {
    refreshInterval: 60_000,
    ...config,
  });
}

/** Inbox list — refresh every 30s */
export function useInbox(query?: string, config?: SWRConfiguration) {
  const path = query ? `/api/inbox?${query}` : "/api/inbox";
  return useSWR(path, fetcher, {
    refreshInterval: 30_000,
    ...config,
  });
}

/** Inbox detail */
export function useInboxItem(id: string | null, config?: SWRConfiguration) {
  return useSWR(id ? `/api/inbox/${id}` : null, fetcher, config);
}

/** Actions list — refresh every 30s */
export function useActions(query?: string, config?: SWRConfiguration) {
  const path = query ? `/api/actions?${query}` : "/api/actions";
  return useSWR(path, fetcher, {
    refreshInterval: 30_000,
    ...config,
  });
}

/** Action detail for deep-link fallback */
export function useAction(id: string | null, config?: SWRConfiguration) {
  return useSWR(id ? `/api/actions/${id}` : null, fetcher, config);
}

/** Notifications — refresh every 15s */
export function useNotifications(config?: SWRConfiguration) {
  return useSWR("/api/notifications", fetcher, {
    refreshInterval: 15_000,
    ...config,
  });
}

/** Cycle status — refresh every 5s */
export function useCycleStatus(config?: SWRConfiguration) {
  return useSWR("/api/cycle/status", fetcher, {
    refreshInterval: 5_000,
    ...config,
  });
}

/** Cycle errors drill-down — refresh every 10s */
export function useCycleErrors(
  options?: {
    limit?: number;
    component?: string | null;
    stage?: string | null;
    scope?: "global" | "action" | null;
  },
  config?: SWRConfiguration,
) {
  const params = new URLSearchParams();
  params.set("limit", String(options?.limit ?? 25));
  if (options?.component) params.set("component", options.component);
  if (options?.stage) params.set("stage", options.stage);
  if (options?.scope) params.set("scope", options.scope);

  return useSWR(`/api/cycle/errors?${params.toString()}`, fetcher, {
    refreshInterval: 10_000,
    ...config,
  });
}

/** Integration status — refresh every 60s */
export function useStatus(config?: SWRConfiguration) {
  return useSWR("/api/status", fetcher, {
    refreshInterval: 60_000,
    ...config,
  });
}

/** Notification preferences */
export function useNotificationPreferences(config?: SWRConfiguration) {
  return useSWR("/api/notification-preferences", fetcher, config);
}

/** User profile preferences */
export function useUserProfile(config?: SWRConfiguration) {
  return useSWR<UserProfileResponse>("/api/profile", fetcher, config);
}

/** Deadlines — refresh every 30s */
export function useDeadlines(query?: string, config?: SWRConfiguration) {
  const path = query ? `/api/deadlines?${query}` : "/api/deadlines";
  return useSWR(path, fetcher, {
    refreshInterval: 30_000,
    ...config,
  });
}

/** Finance statements — refresh every 30s */
export function useFinanceStatements(query?: string, config?: SWRConfiguration) {
  const path = query ? `/api/finance/statements?${query}` : "/api/finance/statements";
  return useSWR(path, fetcher, {
    refreshInterval: 30_000,
    ...config,
  });
}

/** Finance transactions — refresh every 30s */
export function useFinanceTransactions(query?: string, config?: SWRConfiguration) {
  const path = query
    ? `/api/finance/statements/transactions?${query}`
    : "/api/finance/statements/transactions";
  return useSWR(path, fetcher, {
    refreshInterval: 30_000,
    ...config,
  });
}

/** Finance insights — refresh every 30s */
export function useFinanceInsights(query?: string, config?: SWRConfiguration) {
  const path = query
    ? `/api/finance/statements/insights?${query}`
    : "/api/finance/statements/insights";
  return useSWR(path, fetcher, {
    refreshInterval: 30_000,
    ...config,
  });
}
