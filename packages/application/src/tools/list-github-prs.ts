import { z } from "zod";
import type { GitHubPort } from "@oneon/domain";
import type { ToolDefinition, ToolResult } from "./tool-registry.js";

// ── Input Schema ─────────────────────────────────────────────

export const listGitHubPRsSchema = z.object({
  state: z
    .enum(["open", "closed", "all"])
    .optional()
    .default("open")
    .describe("Filter PRs by state. Defaults to 'open'."),
  author: z
    .string()
    .optional()
    .describe("Filter PRs by author login. When no repo is specified this searches across all repos."),
  repo: z
    .string()
    .regex(/^[^/]+\/[^/]+$/, "Must be in 'owner/repo' format")
    .optional()
    .describe("Limit results to a specific repository (e.g. 'octocat/hello-world')."),
});

export type ListGitHubPRsInput = z.infer<typeof listGitHubPRsSchema>;

// ── Deps ─────────────────────────────────────────────────────

export interface ListGitHubPRsDeps {
  githubPort: GitHubPort;
}

// ── Factory ──────────────────────────────────────────────────

export function createListGitHubPRsTool(
  deps: ListGitHubPRsDeps,
): ToolDefinition {
  return {
    name: "list_github_prs",
    version: "1.0.0",
    description:
      "List GitHub pull requests. Supports filtering by state, author, and repository. When repo is specified, queries that repo directly; otherwise searches across all repos.",
    inputSchema: listGitHubPRsSchema,
    async execute(validatedInput: unknown): Promise<ToolResult> {
      const input = validatedInput as ListGitHubPRsInput;

      const prs = await deps.githubPort.listPullRequests({
        state: input.state,
        author: input.author,
        repo: input.repo,
      });

      const count = prs.length;

      return {
        data: prs,
        summary:
          count === 0
            ? "No pull requests found."
            : `Found ${count} pull request${count === 1 ? "" : "s"}.`,
      };
    },
  };
}
