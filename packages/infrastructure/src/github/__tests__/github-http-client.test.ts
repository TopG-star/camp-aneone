import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GitHubHttpClient } from "../github-http-client.js";
import type { GHNotificationResource, GHPullRequestResource, GHSearchIssuesResponse } from "../github.types.js";

// ── Mock fetch ───────────────────────────────────────────────

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function okJson(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(data),
  } as unknown as Response;
}

function errorResponse(status: number, body: string): Response {
  return {
    ok: false,
    status,
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

const TOKEN = "ghp_test_token_123";

describe("GitHubHttpClient", () => {
  describe("common headers", () => {
    it("sends Authorization, Accept, and X-GitHub-Api-Version headers", async () => {
      mockFetch.mockResolvedValue(okJson([]));
      const client = new GitHubHttpClient(TOKEN);

      await client.listNotifications();

      const [, init] = mockFetch.mock.calls[0];
      expect(init.headers).toMatchObject({
        Authorization: `Bearer ${TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      });
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValue(errorResponse(401, "Bad credentials"));
      const client = new GitHubHttpClient(TOKEN);

      await expect(client.listNotifications()).rejects.toThrow(
        "GitHub API error 401: Bad credentials",
      );
    });
  });

  // ── listNotifications ────────────────────────────────────

  describe("listNotifications", () => {
    it("calls GET /notifications with no params by default", async () => {
      mockFetch.mockResolvedValue(okJson([]));
      const client = new GitHubHttpClient(TOKEN);

      const result = await client.listNotifications();

      expect(result).toEqual([]);
      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.pathname).toBe("/notifications");
      expect(url.searchParams.toString()).toBe("");
    });

    it("passes all and participating params", async () => {
      mockFetch.mockResolvedValue(okJson([]));
      const client = new GitHubHttpClient(TOKEN);

      await client.listNotifications({ all: true, participating: false });

      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.searchParams.get("all")).toBe("true");
      expect(url.searchParams.get("participating")).toBe("false");
    });

    it("returns parsed notification resources", async () => {
      const notification: GHNotificationResource = {
        id: "123",
        reason: "review_requested",
        subject: { title: "Fix bug", type: "PullRequest", url: "https://api.github.com/repos/owner/repo/pulls/1" },
        repository: { full_name: "owner/repo" },
        updated_at: "2026-04-18T10:00:00Z",
        unread: true,
      };
      mockFetch.mockResolvedValue(okJson([notification]));
      const client = new GitHubHttpClient(TOKEN);

      const result = await client.listNotifications();

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("123");
      expect(result[0].repository.full_name).toBe("owner/repo");
    });
  });

  // ── listPullRequests ─────────────────────────────────────

  describe("listPullRequests", () => {
    it("calls GET /repos/:owner/:repo/pulls", async () => {
      mockFetch.mockResolvedValue(okJson([]));
      const client = new GitHubHttpClient(TOKEN);

      await client.listPullRequests("octocat", "hello-world");

      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.pathname).toBe("/repos/octocat/hello-world/pulls");
    });

    it("URL-encodes owner and repo", async () => {
      mockFetch.mockResolvedValue(okJson([]));
      const client = new GitHubHttpClient(TOKEN);

      await client.listPullRequests("org/special", "my repo");

      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.pathname).toBe("/repos/org%2Fspecial/my%20repo/pulls");
    });

    it("passes state, sort, direction, per_page params", async () => {
      mockFetch.mockResolvedValue(okJson([]));
      const client = new GitHubHttpClient(TOKEN);

      await client.listPullRequests("owner", "repo", {
        state: "open",
        sort: "updated",
        direction: "desc",
        per_page: 50,
      });

      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.searchParams.get("state")).toBe("open");
      expect(url.searchParams.get("sort")).toBe("updated");
      expect(url.searchParams.get("direction")).toBe("desc");
      expect(url.searchParams.get("per_page")).toBe("50");
    });

    it("returns parsed pull request resources", async () => {
      const pr: GHPullRequestResource = {
        id: 456,
        number: 1,
        title: "Add feature",
        state: "open",
        user: { login: "alice" },
        html_url: "https://github.com/owner/repo/pull/1",
        created_at: "2026-04-18T09:00:00Z",
        updated_at: "2026-04-18T10:00:00Z",
      };
      mockFetch.mockResolvedValue(okJson([pr]));
      const client = new GitHubHttpClient(TOKEN);

      const result = await client.listPullRequests("owner", "repo");

      expect(result).toHaveLength(1);
      expect(result[0].number).toBe(1);
      expect(result[0].user?.login).toBe("alice");
    });
  });

  // ── searchIssues ─────────────────────────────────────────

  describe("searchIssues", () => {
    it("calls GET /search/issues with q param", async () => {
      const response: GHSearchIssuesResponse = {
        total_count: 0,
        incomplete_results: false,
        items: [],
      };
      mockFetch.mockResolvedValue(okJson(response));
      const client = new GitHubHttpClient(TOKEN);

      await client.searchIssues("is:pr state:open author:alice");

      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.pathname).toBe("/search/issues");
      expect(url.searchParams.get("q")).toBe("is:pr state:open author:alice");
    });

    it("returns parsed search response", async () => {
      const response: GHSearchIssuesResponse = {
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
          pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/42", html_url: "https://github.com/owner/repo/pull/42" },
        }],
      };
      mockFetch.mockResolvedValue(okJson(response));
      const client = new GitHubHttpClient(TOKEN);

      const result = await client.searchIssues("is:pr state:open");

      expect(result.total_count).toBe(1);
      expect(result.items[0].number).toBe(42);
    });
  });
});
