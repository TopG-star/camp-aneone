import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitHubAdapter } from "../github-adapter.js";
import type { GitHubHttpClient } from "../github-http-client.js";
import type { GHNotificationResource, GHPullRequestResource, GHSearchIssuesResponse } from "../github.types.js";
import type { GitHubNotification, GitHubPullRequest } from "@oneon/domain";
import { TTLCache } from "../../cache/ttl-cache.js";

// ── Mock factories ───────────────────────────────────────────

function mockClient(): GitHubHttpClient {
  return {
    listNotifications: vi.fn().mockResolvedValue([]),
    listPullRequests: vi.fn().mockResolvedValue([]),
    searchIssues: vi.fn().mockResolvedValue({ total_count: 0, incomplete_results: false, items: [] }),
  } as unknown as GitHubHttpClient;
}

function makeNotification(overrides: Partial<GHNotificationResource> = {}): GHNotificationResource {
  return {
    id: "notif-1",
    reason: "review_requested",
    subject: { title: "Fix bug", type: "PullRequest", url: "https://api.github.com/repos/owner/repo/pulls/1" },
    repository: { full_name: "owner/repo" },
    updated_at: "2026-04-18T10:00:00Z",
    unread: true,
    ...overrides,
  };
}

function makePR(overrides: Partial<GHPullRequestResource> = {}): GHPullRequestResource {
  return {
    id: 456,
    number: 1,
    title: "Add feature",
    state: "open",
    user: { login: "alice" },
    html_url: "https://github.com/owner/repo/pull/1",
    created_at: "2026-04-18T09:00:00Z",
    updated_at: "2026-04-18T10:00:00Z",
    ...overrides,
  };
}

function createAdapter(client?: GitHubHttpClient): {
  adapter: GitHubAdapter;
  client: GitHubHttpClient;
  notificationCache: TTLCache<GitHubNotification[]>;
  searchCache: TTLCache<GitHubPullRequest[]>;
} {
  const c = client ?? mockClient();
  const notificationCache = new TTLCache<GitHubNotification[]>();
  const searchCache = new TTLCache<GitHubPullRequest[]>();
  return {
    adapter: new GitHubAdapter({
      client: c,
      notificationCache,
      searchCache,
      notificationCacheTtlMs: 30_000,
      searchCacheTtlMs: 60_000,
    }),
    client: c,
    notificationCache,
    searchCache,
  };
}

describe("GitHubAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── listNotifications ──────────────────────────────────

  describe("listNotifications", () => {
    it("maps API notification to domain GitHubNotification", async () => {
      const { adapter, client } = createAdapter();
      (client.listNotifications as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeNotification(),
      ]);

      const result = await adapter.listNotifications();

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        id: "notif-1",
        reason: "review_requested",
        subject: { title: "Fix bug", type: "PullRequest", url: "https://api.github.com/repos/owner/repo/pulls/1" },
        repository: "owner/repo",
        updatedAt: "2026-04-18T10:00:00Z",
        unread: true,
      });
    });

    it("passes options to client", async () => {
      const { adapter, client } = createAdapter();

      await adapter.listNotifications({ all: true, participating: false });

      expect(client.listNotifications).toHaveBeenCalledWith({
        all: true,
        participating: false,
      });
    });

    it("caches notification results", async () => {
      const { adapter, client } = createAdapter();
      (client.listNotifications as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeNotification(),
      ]);

      await adapter.listNotifications();
      await adapter.listNotifications();

      expect(client.listNotifications).toHaveBeenCalledTimes(1);
    });

    it("uses different cache keys for different options", async () => {
      const { adapter, client } = createAdapter();
      (client.listNotifications as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await adapter.listNotifications({ all: false });
      await adapter.listNotifications({ all: true });

      expect(client.listNotifications).toHaveBeenCalledTimes(2);
    });
  });

  // ── listPullRequests (direct) ──────────────────────────

  describe("listPullRequests (direct — with repo)", () => {
    it("calls client.listPullRequests when repo specified", async () => {
      const { adapter, client } = createAdapter();
      (client.listPullRequests as ReturnType<typeof vi.fn>).mockResolvedValue([makePR()]);

      const result = await adapter.listPullRequests({ repo: "owner/repo" });

      expect(client.listPullRequests).toHaveBeenCalledWith("owner", "repo", { state: "open" });
      expect(result).toHaveLength(1);
      expect(result[0].repo).toBe("owner/repo");
    });

    it("maps PR to domain GitHubPullRequest", async () => {
      const { adapter, client } = createAdapter();
      (client.listPullRequests as ReturnType<typeof vi.fn>).mockResolvedValue([makePR()]);

      const [pr] = await adapter.listPullRequests({ repo: "owner/repo" });

      expect(pr).toEqual({
        id: 456,
        number: 1,
        title: "Add feature",
        state: "open",
        author: "alice",
        repo: "owner/repo",
        url: "https://github.com/owner/repo/pull/1",
        createdAt: "2026-04-18T09:00:00Z",
        updatedAt: "2026-04-18T10:00:00Z",
      });
    });

    it("filters by author client-side", async () => {
      const { adapter, client } = createAdapter();
      (client.listPullRequests as ReturnType<typeof vi.fn>).mockResolvedValue([
        makePR({ user: { login: "alice" } }),
        makePR({ id: 789, number: 2, user: { login: "bob" } }),
      ]);

      const result = await adapter.listPullRequests({ repo: "owner/repo", author: "alice" });

      expect(result).toHaveLength(1);
      expect(result[0].author).toBe("alice");
    });

    it("passes custom state to direct API", async () => {
      const { adapter, client } = createAdapter();
      (client.listPullRequests as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await adapter.listPullRequests({ repo: "owner/repo", state: "closed" });

      expect(client.listPullRequests).toHaveBeenCalledWith("owner", "repo", { state: "closed" });
    });

    it("throws on invalid repo format", async () => {
      const { adapter } = createAdapter();

      await expect(adapter.listPullRequests({ repo: "invalid" })).rejects.toThrow(
        'Invalid repo format "invalid": expected "owner/repo"',
      );
    });

    it("throws on repo format with extra slashes", async () => {
      const { adapter } = createAdapter();

      await expect(adapter.listPullRequests({ repo: "a/b/c" })).rejects.toThrow(
        'Invalid repo format "a/b/c": expected "owner/repo"',
      );
    });

    it("defaults missing user to (unknown)", async () => {
      const { adapter, client } = createAdapter();
      (client.listPullRequests as ReturnType<typeof vi.fn>).mockResolvedValue([
        makePR({ user: null }),
      ]);

      const [pr] = await adapter.listPullRequests({ repo: "owner/repo" });
      expect(pr.author).toBe("(unknown)");
    });
  });

  // ── listPullRequests (search) ──────────────────────────

  describe("listPullRequests (search — no repo)", () => {
    it("calls searchIssues with is:pr query when no repo", async () => {
      const { adapter, client } = createAdapter();
      const response: GHSearchIssuesResponse = {
        total_count: 0,
        incomplete_results: false,
        items: [],
      };
      (client.searchIssues as ReturnType<typeof vi.fn>).mockResolvedValue(response);

      await adapter.listPullRequests({ state: "open", author: "alice" });

      expect(client.searchIssues).toHaveBeenCalledWith("is:pr state:open author:alice");
      expect(client.listPullRequests).not.toHaveBeenCalled();
    });

    it("defaults state to open", async () => {
      const { adapter, client } = createAdapter();
      (client.searchIssues as ReturnType<typeof vi.fn>).mockResolvedValue({
        total_count: 0,
        incomplete_results: false,
        items: [],
      });

      await adapter.listPullRequests();

      expect(client.searchIssues).toHaveBeenCalledWith("is:pr state:open");
    });

    it("maps search results to domain GitHubPullRequest", async () => {
      const { adapter, client } = createAdapter();
      (client.searchIssues as ReturnType<typeof vi.fn>).mockResolvedValue({
        total_count: 1,
        incomplete_results: false,
        items: [{
          id: 789,
          number: 42,
          title: "Update deps",
          state: "open",
          user: { login: "bob" },
          html_url: "https://github.com/owner/repo/pull/42",
          created_at: "2026-04-17T08:00:00Z",
          updated_at: "2026-04-18T10:00:00Z",
          repository_url: "https://api.github.com/repos/owner/repo",
          pull_request: { url: "...", html_url: "..." },
        }],
      });

      const [pr] = await adapter.listPullRequests();

      expect(pr).toEqual({
        id: 789,
        number: 42,
        title: "Update deps",
        state: "open",
        author: "bob",
        repo: "owner/repo",
        url: "https://github.com/owner/repo/pull/42",
        createdAt: "2026-04-17T08:00:00Z",
        updatedAt: "2026-04-18T10:00:00Z",
      });
    });

    it("filters out non-PR items from search results", async () => {
      const { adapter, client } = createAdapter();
      (client.searchIssues as ReturnType<typeof vi.fn>).mockResolvedValue({
        total_count: 2,
        incomplete_results: false,
        items: [
          {
            id: 1, number: 1, title: "PR", state: "open", user: { login: "a" },
            html_url: "...", created_at: "...", updated_at: "...",
            repository_url: "https://api.github.com/repos/x/y",
            pull_request: { url: "...", html_url: "..." },
          },
          {
            id: 2, number: 2, title: "Issue", state: "open", user: { login: "b" },
            html_url: "...", created_at: "...", updated_at: "...",
            repository_url: "https://api.github.com/repos/x/y",
            // no pull_request field → this is a plain issue
          },
        ],
      });

      const result = await adapter.listPullRequests();
      expect(result).toHaveLength(1);
      expect(result[0].title).toBe("PR");
    });

    it("caches search results", async () => {
      const { adapter, client } = createAdapter();
      (client.searchIssues as ReturnType<typeof vi.fn>).mockResolvedValue({
        total_count: 0, incomplete_results: false, items: [],
      });

      await adapter.listPullRequests({ state: "open" });
      await adapter.listPullRequests({ state: "open" });

      expect(client.searchIssues).toHaveBeenCalledTimes(1);
    });

    it("uses different cache keys for different queries", async () => {
      const { adapter, client } = createAdapter();
      (client.searchIssues as ReturnType<typeof vi.fn>).mockResolvedValue({
        total_count: 0, incomplete_results: false, items: [],
      });

      await adapter.listPullRequests({ state: "open" });
      await adapter.listPullRequests({ state: "closed" });

      expect(client.searchIssues).toHaveBeenCalledTimes(2);
    });
  });
});
