import type {
  GHNotificationResource,
  GHPullRequestResource,
  GHSearchIssuesResponse,
} from "./github.types.js";
import { fetchWithRetry } from "../http/fetch-with-retry.js";

const BASE_URL = "https://api.github.com";

const GITHUB_API_VERSION = "2022-11-28";

export interface ListNotificationsOptions {
  all?: boolean;
  participating?: boolean;
}

export interface ListPullRequestsOptions {
  state?: string; // "open" | "closed" | "all"
  sort?: string;
  direction?: string;
  per_page?: number;
}

/**
 * Thin fetch wrapper around the GitHub REST API v3.
 * Uses a static personal access token (PAT) — no OAuth refresh flow.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

export class GitHubHttpClient {
  private readonly timeoutMs: number;

  constructor(
    private readonly token: string,
    options?: { timeoutMs?: number },
  ) {
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async listNotifications(
    options: ListNotificationsOptions = {},
  ): Promise<GHNotificationResource[]> {
    const url = new URL(`${BASE_URL}/notifications`);
    if (options.all !== undefined) {
      url.searchParams.set("all", String(options.all));
    }
    if (options.participating !== undefined) {
      url.searchParams.set("participating", String(options.participating));
    }

    const response = await this.request(url);
    return (await response.json()) as GHNotificationResource[];
  }

  async listPullRequests(
    owner: string,
    repo: string,
    options: ListPullRequestsOptions = {},
  ): Promise<GHPullRequestResource[]> {
    const url = new URL(
      `${BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
    );
    if (options.state) url.searchParams.set("state", options.state);
    if (options.sort) url.searchParams.set("sort", options.sort);
    if (options.direction) url.searchParams.set("direction", options.direction);
    if (options.per_page !== undefined) {
      url.searchParams.set("per_page", String(options.per_page));
    }

    const response = await this.request(url);
    return (await response.json()) as GHPullRequestResource[];
  }

  async searchIssues(query: string): Promise<GHSearchIssuesResponse> {
    const url = new URL(`${BASE_URL}/search/issues`);
    url.searchParams.set("q", query);

    const response = await this.request(url);
    return (await response.json()) as GHSearchIssuesResponse;
  }

  private async request(url: URL, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetchWithRetry(() =>
        fetch(url.toString(), {
          ...init,
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": GITHUB_API_VERSION,
            ...(init?.headers as Record<string, string> | undefined),
          },
          signal: controller.signal,
        }),
      );

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`GitHub API error ${response.status}: ${errorBody}`);
      }

      return response;
    } finally {
      clearTimeout(timeout);
    }
  }
}
