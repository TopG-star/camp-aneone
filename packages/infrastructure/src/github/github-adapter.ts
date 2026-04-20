import type { GitHubPort, GitHubNotification, GitHubPullRequest } from "@oneon/domain";
import type { GitHubHttpClient } from "./github-http-client.js";
import type { GHNotificationResource, GHPullRequestResource, GHSearchIssueItem } from "./github.types.js";
import type { TTLCache } from "../cache/ttl-cache.js";

export interface GitHubAdapterConfig {
  client: GitHubHttpClient;
  notificationCache: TTLCache<GitHubNotification[]>;
  searchCache: TTLCache<GitHubPullRequest[]>;
  notificationCacheTtlMs: number;
  searchCacheTtlMs: number;
}

const OWNER_REPO_REGEX = /^[^/]+\/[^/]+$/;

/**
 * Implements GitHubPort via GitHub REST API v3.
 *
 * Features:
 * - Hybrid PR listing: direct API for single-repo, search API for cross-repo
 * - TTL caching on notifications (30-60s) and search queries
 * - Validates owner/repo format
 */
export class GitHubAdapter implements GitHubPort {
  private readonly client: GitHubHttpClient;
  private readonly notificationCache: TTLCache<GitHubNotification[]>;
  private readonly searchCache: TTLCache<GitHubPullRequest[]>;
  private readonly notificationCacheTtlMs: number;
  private readonly searchCacheTtlMs: number;

  constructor(config: GitHubAdapterConfig) {
    this.client = config.client;
    this.notificationCache = config.notificationCache;
    this.searchCache = config.searchCache;
    this.notificationCacheTtlMs = config.notificationCacheTtlMs;
    this.searchCacheTtlMs = config.searchCacheTtlMs;
  }

  async listNotifications(
    options?: { all?: boolean; participating?: boolean },
  ): Promise<GitHubNotification[]> {
    const cacheKey = `gh:notif:${options?.all ?? false}|${options?.participating ?? false}`;

    return this.notificationCache.getOrSet(
      cacheKey,
      async () => {
        const resources = await this.client.listNotifications(options);
        return resources.map(mapNotificationToDomain);
      },
      this.notificationCacheTtlMs,
    );
  }

  async listPullRequests(
    options?: { state?: string; author?: string; repo?: string },
  ): Promise<GitHubPullRequest[]> {
    if (options?.repo) {
      return this.listPullRequestsDirect(options.repo, options);
    }
    return this.listPullRequestsSearch(options);
  }

  private async listPullRequestsDirect(
    repoSlug: string,
    options?: { state?: string; author?: string },
  ): Promise<GitHubPullRequest[]> {
    if (!OWNER_REPO_REGEX.test(repoSlug)) {
      throw new Error(
        `Invalid repo format "${repoSlug}": expected "owner/repo"`,
      );
    }

    const [owner, repo] = repoSlug.split("/");
    const resources = await this.client.listPullRequests(owner, repo, {
      state: options?.state ?? "open",
    });

    let prs = resources.map((r) => mapPullRequestToDomain(r, repoSlug));

    // Client-side author filter (direct API doesn't support author filter)
    if (options?.author) {
      const author = options.author.toLowerCase();
      prs = prs.filter((pr) => pr.author.toLowerCase() === author);
    }

    return prs;
  }

  private async listPullRequestsSearch(
    options?: { state?: string; author?: string },
  ): Promise<GitHubPullRequest[]> {
    const parts = ["is:pr"];
    const state = options?.state ?? "open";
    parts.push(`state:${state}`);
    if (options?.author) {
      parts.push(`author:${options.author}`);
    }
    const query = parts.join(" ");

    const cacheKey = `gh:search:${query}`;

    return this.searchCache.getOrSet(
      cacheKey,
      async () => {
        const response = await this.client.searchIssues(query);
        return response.items
          .filter((item) => item.pull_request !== undefined)
          .map(mapSearchItemToDomain);
      },
      this.searchCacheTtlMs,
    );
  }
}

// ── Mapping helpers (module-private) ─────────────────────────

function mapNotificationToDomain(
  resource: GHNotificationResource,
): GitHubNotification {
  return {
    id: resource.id,
    reason: resource.reason,
    subject: {
      title: resource.subject.title,
      type: resource.subject.type,
      url: resource.subject.url,
    },
    repository: resource.repository.full_name,
    updatedAt: resource.updated_at,
    unread: resource.unread,
  };
}

function mapPullRequestToDomain(
  resource: GHPullRequestResource,
  repoSlug: string,
): GitHubPullRequest {
  return {
    id: resource.id,
    number: resource.number,
    title: resource.title,
    state: resource.state,
    author: resource.user?.login ?? "(unknown)",
    repo: repoSlug,
    url: resource.html_url,
    createdAt: resource.created_at,
    updatedAt: resource.updated_at,
  };
}

/**
 * Extract "owner/repo" from a search item's repository_url.
 * e.g. "https://api.github.com/repos/owner/repo" → "owner/repo"
 */
function extractRepoSlug(repositoryUrl: string): string {
  const match = repositoryUrl.match(/\/repos\/(.+)$/);
  return match ? match[1] : repositoryUrl;
}

function mapSearchItemToDomain(
  item: GHSearchIssueItem,
): GitHubPullRequest {
  return {
    id: item.id,
    number: item.number,
    title: item.title,
    state: item.state,
    author: item.user?.login ?? "(unknown)",
    repo: extractRepoSlug(item.repository_url),
    url: item.html_url,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  };
}
