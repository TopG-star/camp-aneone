import { describe, it, expect, vi } from "vitest";
import type { GitHubNotification } from "@oneon/domain";
import {
  createListGitHubNotificationsTool,
  listGitHubNotificationsSchema,
  type ListGitHubNotificationsDeps,
} from "./list-github-notifications.js";
import { createToolRegistry } from "./tool-registry.js";

// ── Fixtures ─────────────────────────────────────────────────

function makeNotification(
  overrides: Partial<GitHubNotification> = {},
): GitHubNotification {
  return {
    id: "notif-1",
    reason: "mention",
    subject: { title: "Fix bug #42", type: "PullRequest", url: "https://api.github.com/repos/o/r/pulls/42" },
    repository: "octocat/hello-world",
    updatedAt: "2025-01-20T10:00:00Z",
    unread: true,
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<ListGitHubNotificationsDeps> = {},
): ListGitHubNotificationsDeps {
  return {
    githubPort: {
      listNotifications: vi.fn().mockResolvedValue([]),
      listPullRequests: vi.fn().mockResolvedValue([]),
    },
    ...overrides,
  };
}

// ── Schema Tests ─────────────────────────────────────────────

describe("listGitHubNotificationsSchema", () => {
  it("accepts empty input with defaults", () => {
    const result = listGitHubNotificationsSchema.parse({});
    expect(result.all).toBe(false);
    expect(result.participating).toBe(false);
  });

  it("accepts all=true", () => {
    const result = listGitHubNotificationsSchema.parse({ all: true });
    expect(result.all).toBe(true);
  });

  it("accepts participating=true", () => {
    const result = listGitHubNotificationsSchema.parse({ participating: true });
    expect(result.participating).toBe(true);
  });
});

// ── Tool Execution Tests ─────────────────────────────────────

describe("list_github_notifications tool", () => {
  it("calls githubPort.listNotifications with provided options", async () => {
    const deps = makeDeps();
    const tool = createListGitHubNotificationsTool(deps);

    await tool.execute({ all: true, participating: false });

    expect(deps.githubPort.listNotifications).toHaveBeenCalledWith({
      all: true,
      participating: false,
    });
  });

  it("returns notifications in data field", async () => {
    const deps = makeDeps();
    (deps.githubPort.listNotifications as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeNotification(),
      makeNotification({ id: "notif-2", reason: "review_requested" }),
    ]);
    const tool = createListGitHubNotificationsTool(deps);

    const result = await tool.execute({ all: false, participating: false });

    expect(result.data).toHaveLength(2);
    expect(result.summary).toBe("Found 2 GitHub notifications.");
  });

  it("returns zero-count summary when empty", async () => {
    const deps = makeDeps();
    const tool = createListGitHubNotificationsTool(deps);

    const result = await tool.execute({ all: false, participating: false });

    expect(result.data).toEqual([]);
    expect(result.summary).toBe("No GitHub notifications found.");
  });

  it("uses singular form for exactly 1 notification", async () => {
    const deps = makeDeps();
    (deps.githubPort.listNotifications as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeNotification(),
    ]);
    const tool = createListGitHubNotificationsTool(deps);

    const result = await tool.execute({ all: false, participating: false });

    expect(result.summary).toBe("Found 1 GitHub notification.");
  });

  it("integrates with tool registry", async () => {
    const deps = makeDeps();
    (deps.githubPort.listNotifications as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeNotification(),
    ]);

    const registry = createToolRegistry();
    registry.register(createListGitHubNotificationsTool(deps));

    const result = await registry.execute("list_github_notifications", {});

    expect(result.data).toHaveLength(1);
    expect(result.meta.toolName).toBe("list_github_notifications");
  });
});
