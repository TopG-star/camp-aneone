/**
 * Minimal type definitions for the GitHub REST API v3 responses.
 * Only the fields we actually consume are typed.
 * @see https://docs.github.com/en/rest
 */

// ── Notifications (/notifications) ─────────────────────────

export interface GHNotificationResource {
  id: string;
  reason: string;
  subject: {
    title: string;
    type: string;
    url: string;
  };
  repository: {
    full_name: string;
  };
  updated_at: string;
  unread: boolean;
}

// ── Pull Requests (/repos/:owner/:repo/pulls) ──────────────

export interface GHPullRequestResource {
  id: number;
  number: number;
  title: string;
  state: string; // "open" | "closed"
  user: { login: string } | null;
  html_url: string;
  created_at: string;
  updated_at: string;
}

// ── Search Issues (/search/issues) ─────────────────────────

export interface GHSearchIssuesResponse {
  total_count: number;
  incomplete_results: boolean;
  items: GHSearchIssueItem[];
}

export interface GHSearchIssueItem {
  id: number;
  number: number;
  title: string;
  state: string;
  user: { login: string } | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  /** Present in search results; contains the "owner/repo" slug */
  repository_url: string;
  pull_request?: {
    url: string;
    html_url: string;
  };
}

// ── Webhook Payloads ────────────────────────────────────────

export interface GHWebhookPRPayload {
  action: string; // "opened" | "reopened" | "synchronize" | "ready_for_review"
  number: number;
  pull_request: {
    id: number;
    number: number;
    title: string;
    state: string;
    user: { login: string } | null;
    html_url: string;
    body: string | null;
    created_at: string;
    updated_at: string;
  };
  repository: {
    full_name: string;
  };
  sender: {
    login: string;
  };
}

export interface GHWebhookIssuePayload {
  action: string; // "opened"
  issue: {
    id: number;
    number: number;
    title: string;
    state: string;
    user: { login: string } | null;
    html_url: string;
    body: string | null;
    created_at: string;
    updated_at: string;
  };
  repository: {
    full_name: string;
  };
  sender: {
    login: string;
  };
}

// ── Accepted webhook actions ────────────────────────────────

export const ACCEPTED_PR_ACTIONS = [
  "opened",
  "reopened",
  "synchronize",
  "ready_for_review",
] as const;

export const ACCEPTED_ISSUE_ACTIONS = ["opened"] as const;
