import { describe, it, expect, vi } from "vitest";
import type { GitHubPullRequest } from "@oneon/domain";
import {
  createListGitHubPRsTool,
  listGitHubPRsSchema,
  type ListGitHubPRsDeps,
} from "./list-github-prs.js";
import { createToolRegistry } from "./tool-registry.js";

// ── Fixtures ─────────────────────────────────────────────────

function makePR(overrides: Partial<GitHubPullRequest> = {}): GitHubPullRequest {
  return {
    id: 1001,
    number: 42,
    title: "Fix README typo",
    state: "open",
    author: "octocat",
    repo: "octocat/hello-world",
    url: "https://github.com/octocat/hello-world/pull/42",
    createdAt: "2025-01-20T14:00:00Z",
    updatedAt: "2025-01-20T14:30:00Z",
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<ListGitHubPRsDeps> = {},
): ListGitHubPRsDeps {
  return {
    githubPort: {
      listNotifications: vi.fn().mockResolvedValue([]),
      listPullRequests: vi.fn().mockResolvedValue([]),
    },
    ...overrides,
  };
}

// ── Schema Tests ─────────────────────────────────────────────

describe("listGitHubPRsSchema", () => {
  it("accepts empty input with defaults", () => {
    const result = listGitHubPRsSchema.parse({});
    expect(result.state).toBe("open");
    expect(result.author).toBeUndefined();
    expect(result.repo).toBeUndefined();
  });

  it("accepts state filter", () => {
    for (const s of ["open", "closed", "all"]) {
      const result = listGitHubPRsSchema.parse({ state: s });
      expect(result.state).toBe(s);
    }
  });

  it("rejects invalid state", () => {
    expect(() => listGitHubPRsSchema.parse({ state: "merged" })).toThrow();
  });

  it("accepts valid repo format", () => {
    const result = listGitHubPRsSchema.parse({ repo: "octocat/hello-world" });
    expect(result.repo).toBe("octocat/hello-world");
  });

  it("rejects invalid repo format (no slash)", () => {
    expect(() => listGitHubPRsSchema.parse({ repo: "hello-world" })).toThrow();
  });

  it("rejects repo with only a slash", () => {
    expect(() => listGitHubPRsSchema.parse({ repo: "/" })).toThrow();
  });

  it("accepts author filter", () => {
    const result = listGitHubPRsSchema.parse({ author: "octocat" });
    expect(result.author).toBe("octocat");
  });
});

// ── Tool Execution Tests ─────────────────────────────────────

describe("list_github_prs tool", () => {
  it("calls githubPort.listPullRequests with provided options", async () => {
    const deps = makeDeps();
    const tool = createListGitHubPRsTool(deps);

    await tool.execute({
      state: "open",
      author: "octocat",
      repo: "octocat/hello-world",
    });

    expect(deps.githubPort.listPullRequests).toHaveBeenCalledWith({
      state: "open",
      author: "octocat",
      repo: "octocat/hello-world",
    });
  });

  it("returns pull requests in data field", async () => {
    const deps = makeDeps();
    (deps.githubPort.listPullRequests as ReturnType<typeof vi.fn>).mockResolvedValue([
      makePR(),
      makePR({ id: 1002, number: 43, title: "Add tests" }),
    ]);
    const tool = createListGitHubPRsTool(deps);

    const result = await tool.execute({ state: "open" });

    expect(result.data).toHaveLength(2);
    expect(result.summary).toBe("Found 2 pull requests.");
  });

  it("returns zero-count summary when empty", async () => {
    const deps = makeDeps();
    const tool = createListGitHubPRsTool(deps);

    const result = await tool.execute({ state: "open" });

    expect(result.data).toEqual([]);
    expect(result.summary).toBe("No pull requests found.");
  });

  it("uses singular form for exactly 1 PR", async () => {
    const deps = makeDeps();
    (deps.githubPort.listPullRequests as ReturnType<typeof vi.fn>).mockResolvedValue([
      makePR(),
    ]);
    const tool = createListGitHubPRsTool(deps);

    const result = await tool.execute({ state: "open" });

    expect(result.summary).toBe("Found 1 pull request.");
  });

  it("passes default state=open to port", async () => {
    const deps = makeDeps();
    const tool = createListGitHubPRsTool(deps);

    await tool.execute({ state: "open" });

    expect(deps.githubPort.listPullRequests).toHaveBeenCalledWith(
      expect.objectContaining({ state: "open" }),
    );
  });

  it("integrates with tool registry", async () => {
    const deps = makeDeps();
    (deps.githubPort.listPullRequests as ReturnType<typeof vi.fn>).mockResolvedValue([
      makePR(),
    ]);

    const registry = createToolRegistry();
    registry.register(createListGitHubPRsTool(deps));

    const result = await registry.execute("list_github_prs", {});

    expect(result.data).toHaveLength(1);
    expect(result.meta.toolName).toBe("list_github_prs");
  });
});
