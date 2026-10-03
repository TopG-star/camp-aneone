import { describe, it, expect, vi, beforeEach } from "vitest";
import type { InboundItem, InboundItemRepository } from "@oneon/domain";
import { TeamsInboundAdapter } from "../teams-inbound-adapter.js";

function makeInboundItem(overrides: Partial<InboundItem> = {}): InboundItem {
  return {
    id: "item-1",
    userId: "user-1",
    source: "teams",
    externalId: "msg-1",
    from: "alex@example.com",
    subject: "Daily standup",
    bodyPreview: "Please review blockers",
    receivedAt: "2026-05-04T12:30:00.000Z",
    rawJson: JSON.stringify({
      channelName: "General",
      createdDateTime: "2026-05-04T12:25:00.000Z",
    }),
    threadId: null,
    labels: "[]",
    classifiedAt: null,
    classifyAttempts: 0,
    createdAt: "2026-05-04T12:30:00.000Z",
    updatedAt: "2026-05-04T12:30:00.000Z",
    ...overrides,
  };
}

function makeRepo(
  searchResult: InboundItem[] = [],
): Pick<InboundItemRepository, "search"> {
  return {
    search: vi.fn().mockReturnValue(searchResult),
  };
}

describe("TeamsInboundAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("queries inbound repo with teams source", async () => {
    const inboundItemRepo = makeRepo([makeInboundItem()]);
    const adapter = new TeamsInboundAdapter({ inboundItemRepo });

    await adapter.searchMessages("blocker");

    expect(inboundItemRepo.search).toHaveBeenCalledWith({
      query: "blocker",
      source: "teams",
      limit: 100,
    });
  });

  it("maps inbound rows into TeamsMessage shape", async () => {
    const inboundItemRepo = makeRepo([makeInboundItem()]);
    const adapter = new TeamsInboundAdapter({ inboundItemRepo });

    const result = await adapter.searchMessages("standup");

    expect(result).toEqual([
      {
        id: "msg-1",
        channelName: "General",
        from: "alex@example.com",
        subject: "Daily standup",
        bodyPreview: "Please review blockers",
        createdAt: "2026-05-04T12:25:00.000Z",
      },
    ]);
  });

  it("filters by channel name case-insensitively", async () => {
    const inboundItemRepo = makeRepo([
      makeInboundItem({
        externalId: "msg-1",
        rawJson: JSON.stringify({ channelName: "General" }),
      }),
      makeInboundItem({
        id: "item-2",
        externalId: "msg-2",
        rawJson: JSON.stringify({ channelName: "Engineering" }),
      }),
    ]);
    const adapter = new TeamsInboundAdapter({ inboundItemRepo });

    const result = await adapter.searchMessages("meeting", {
      channelName: "engineering",
    });

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("msg-2");
  });

  it("filters by since using createdDateTime when present", async () => {
    const inboundItemRepo = makeRepo([
      makeInboundItem({
        externalId: "old",
        rawJson: JSON.stringify({ createdDateTime: "2026-05-01T12:00:00.000Z" }),
      }),
      makeInboundItem({
        id: "item-2",
        externalId: "new",
        rawJson: JSON.stringify({ createdDateTime: "2026-05-05T12:00:00.000Z" }),
      }),
    ]);
    const adapter = new TeamsInboundAdapter({ inboundItemRepo });

    const result = await adapter.searchMessages("status", {
      since: "2026-05-03T00:00:00.000Z",
    });

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("new");
  });

  it("uses receivedAt fallback when rawJson is malformed", async () => {
    const inboundItemRepo = makeRepo([
      makeInboundItem({
        externalId: "bad-json",
        receivedAt: "2026-05-04T15:00:00.000Z",
        rawJson: "{bad-json",
      }),
    ]);
    const adapter = new TeamsInboundAdapter({ inboundItemRepo });

    const result = await adapter.searchMessages("review");

    expect(result).toEqual([
      {
        id: "bad-json",
        channelName: "(unknown)",
        from: "alex@example.com",
        subject: "Daily standup",
        bodyPreview: "Please review blockers",
        createdAt: "2026-05-04T15:00:00.000Z",
      },
    ]);
  });
});
