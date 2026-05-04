import { describe, it, expect, vi } from "vitest";
import type { TeamsMessage, TeamsPort } from "@oneon/domain";
import {
  createSearchTeamsMessagesTool,
  searchTeamsMessagesSchema,
  type SearchTeamsMessagesDeps,
} from "./search-teams-messages.js";
import { createToolRegistry } from "./tool-registry.js";

function makeMessage(overrides: Partial<TeamsMessage> = {}): TeamsMessage {
  return {
    id: "teams-1",
    channelName: "Engineering",
    from: "alex@example.com",
    subject: "Build update",
    bodyPreview: "Pipeline is green",
    createdAt: "2026-05-04T14:00:00.000Z",
    ...overrides,
  };
}

function makeDeps(overrides: Partial<SearchTeamsMessagesDeps> = {}): SearchTeamsMessagesDeps {
  const teamsPort: TeamsPort = {
    searchMessages: vi.fn(async () => []),
  };

  return {
    teamsPort,
    ...overrides,
  };
}

describe("searchTeamsMessagesSchema", () => {
  it("accepts valid input", () => {
    const result = searchTeamsMessagesSchema.parse({
      query: "release",
      channelName: "Engineering",
      since: "2026-05-04T00:00:00.000Z",
    });

    expect(result.query).toBe("release");
    expect(result.channelName).toBe("Engineering");
    expect(result.since).toBe("2026-05-04T00:00:00.000Z");
  });

  it("rejects empty query", () => {
    expect(() =>
      searchTeamsMessagesSchema.parse({ query: "" }),
    ).toThrow();
  });

  it("rejects invalid since format", () => {
    expect(() =>
      searchTeamsMessagesSchema.parse({
        query: "release",
        since: "yesterday",
      }),
    ).toThrow();
  });
});

describe("search_teams_messages tool", () => {
  it("delegates to teamsPort with normalized input", async () => {
    const deps = makeDeps({
      teamsPort: {
        searchMessages: vi.fn(async () => [makeMessage()]),
      },
    });

    const tool = createSearchTeamsMessagesTool(deps);
    await tool.execute(
      searchTeamsMessagesSchema.parse({
        query: "release",
        channelName: "Engineering",
        since: "2026-05-04T00:00:00.000Z",
      }),
    );

    expect(deps.teamsPort.searchMessages).toHaveBeenCalledWith("release", {
      channelName: "Engineering",
      since: "2026-05-04T00:00:00.000Z",
    });
  });

  it("returns empty summary when no messages found", async () => {
    const deps = makeDeps({
      teamsPort: {
        searchMessages: vi.fn(async () => []),
      },
    });

    const tool = createSearchTeamsMessagesTool(deps);
    const result = await tool.execute(
      searchTeamsMessagesSchema.parse({ query: "release" }),
    );

    expect(result.data).toEqual([]);
    expect(result.summary).toBe('No Teams messages found for "release".');
  });

  it("returns result summary with message count", async () => {
    const deps = makeDeps({
      teamsPort: {
        searchMessages: vi.fn(async () => [makeMessage(), makeMessage({ id: "teams-2" })]),
      },
    });

    const tool = createSearchTeamsMessagesTool(deps);
    const result = await tool.execute(
      searchTeamsMessagesSchema.parse({ query: "release" }),
    );

    expect(result.summary).toBe('Found 2 Teams message(s) matching "release".');
  });

  it("executes through ToolRegistry", async () => {
    const deps = makeDeps({
      teamsPort: {
        searchMessages: vi.fn(async () => [makeMessage()]),
      },
    });

    const registry = createToolRegistry();
    registry.register(createSearchTeamsMessagesTool(deps));

    const result = await registry.execute("search_teams_messages", {
      query: "release",
    });

    expect(result.data).toHaveLength(1);
    expect(result.meta.toolName).toBe("search_teams_messages");
  });
});
