import { describe, it, expect, vi } from "vitest";
import {
  createSearchPersonalMemoryTool,
  retrievePersonalMemory,
  searchPersonalMemorySchema,
  type PersonalDocMemoryProvider,
} from "./search-personal-memory.js";

describe("searchPersonalMemorySchema", () => {
  it("applies defaults", () => {
    const result = searchPersonalMemorySchema.parse({
      query: "style",
      userId: "user-1",
    });

    expect(result.limit).toBe(10);
    expect(result.includeNotes).toBe(true);
    expect(result.includePins).toBe(true);
    expect(result.includeDocs).toBe(true);
  });
});

describe("retrievePersonalMemory", () => {
  it("merges notes, pins, and docs with ranking", () => {
    const docProvider: PersonalDocMemoryProvider = {
      search: vi.fn().mockReturnValue([
        {
          id: "doc-1",
          title: "Voice Guidelines",
          snippet: "Use concise and direct language.",
          score: 0.8,
          path: "docs/notes/voice.md",
        },
      ]),
    };

    const hits = retrievePersonalMemory(
      {
        personalMemoryNoteRepo: {
          search: vi.fn().mockReturnValue([
            {
              id: "note-1",
              userId: "user-1",
              title: "My writing style",
              content: "Prefer crisp bullet points and direct calls to action.",
              tags: JSON.stringify(["style", "writing"]),
              pinned: true,
              createdAt: "2026-05-08T00:00:00.000Z",
              updatedAt: "2026-05-08T00:00:00.000Z",
            },
          ]),
        },
        personalMemoryPinRepo: {
          search: vi.fn().mockReturnValue([
            {
              id: "pin-1",
              userId: "user-1",
              sourceMessageId: "msg-12",
              conversationId: "conv-1",
              content: "When proposing actions, mention risk and expected impact.",
              createdAt: "2026-05-07T00:00:00.000Z",
            },
          ]),
        },
        docMemoryProvider: docProvider,
      },
      {
        query: "style action",
        userId: "user-1",
        limit: 5,
        includeNotes: true,
        includePins: true,
        includeDocs: true,
      },
    );

    expect(hits.length).toBe(3);
    expect(hits[0].source).toBe("note");
    expect(hits.some((hit) => hit.source === "pin")).toBe(true);
    expect(hits.some((hit) => hit.source === "doc")).toBe(true);
  });

  it("returns empty when no sources match", () => {
    const hits = retrievePersonalMemory(
      {
        personalMemoryNoteRepo: { search: vi.fn().mockReturnValue([]) },
        personalMemoryPinRepo: { search: vi.fn().mockReturnValue([]) },
        docMemoryProvider: { search: vi.fn().mockReturnValue([]) },
      },
      {
        query: "missing",
        userId: "user-1",
        limit: 5,
        includeNotes: true,
        includePins: true,
        includeDocs: true,
      },
    );

    expect(hits).toEqual([]);
  });
});

describe("search_personal_memory tool", () => {
  it("returns summary and data for hits", async () => {
    const tool = createSearchPersonalMemoryTool({
      personalMemoryNoteRepo: {
        search: vi.fn().mockReturnValue([
          {
            id: "note-1",
            userId: "user-1",
            title: "Preference",
            content: "Keep answers concise.",
            tags: "[]",
            pinned: false,
            createdAt: "2026-05-08T00:00:00.000Z",
            updatedAt: "2026-05-08T00:00:00.000Z",
          },
        ]),
      },
      personalMemoryPinRepo: {
        search: vi.fn().mockReturnValue([]),
      },
      docMemoryProvider: null,
    });

    const result = await tool.execute(
      searchPersonalMemorySchema.parse({
        query: "concise",
        userId: "user-1",
      }),
    );

    const data = result.data as Array<{ source: string }>;
    expect(data.length).toBe(1);
    expect(data[0].source).toBe("note");
    expect(result.summary).toContain("Found 1 personal memory match");
  });
});
