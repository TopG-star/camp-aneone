import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type {
  Logger,
  PersonalMemoryNote,
  PersonalMemoryNoteRepository,
  PersonalMemoryPin,
  PersonalMemoryPinRepository,
} from "@oneon/domain";
import type { PersonalDocMemoryProvider } from "@oneon/application";
import { createMemoryRouter, type MemoryRouteDeps } from "./memory.route.js";

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function createMockNoteRepo(): PersonalMemoryNoteRepository {
  const notes = new Map<string, PersonalMemoryNote>();
  let sequence = 0;

  return {
    create: vi.fn((input) => {
      sequence += 1;
      const now = `2026-05-0${sequence}T00:00:00.000Z`;
      const note: PersonalMemoryNote = {
        id: `note-${sequence}`,
        userId: input.userId,
        title: input.title,
        content: input.content,
        tags: input.tags,
        pinned: input.pinned,
        createdAt: now,
        updatedAt: now,
      };
      notes.set(note.id, note);
      return note;
    }),
    findById: vi.fn((id, userId) => {
      const note = notes.get(id) ?? null;
      return note && note.userId === userId ? note : null;
    }),
    list: vi.fn((userId, limit) => {
      return Array.from(notes.values())
        .filter((note) => note.userId === userId)
        .slice(0, limit);
    }),
    search: vi.fn((userId, query, limit) => {
      const q = query.toLowerCase();
      return Array.from(notes.values())
        .filter((note) => note.userId === userId)
        .filter(
          (note) =>
            note.title.toLowerCase().includes(q) ||
            note.content.toLowerCase().includes(q) ||
            note.tags.toLowerCase().includes(q),
        )
        .slice(0, limit);
    }),
    update: vi.fn((id, userId, patch) => {
      const existing = notes.get(id);
      if (!existing || existing.userId !== userId) {
        return null;
      }

      const updated: PersonalMemoryNote = {
        ...existing,
        title: patch.title ?? existing.title,
        content: patch.content ?? existing.content,
        tags: patch.tags ?? existing.tags,
        pinned: patch.pinned ?? existing.pinned,
        updatedAt: "2026-05-31T00:00:00.000Z",
      };
      notes.set(id, updated);
      return updated;
    }),
    delete: vi.fn((id, userId) => {
      const existing = notes.get(id);
      if (!existing || existing.userId !== userId) {
        return false;
      }
      notes.delete(id);
      return true;
    }),
  };
}

function createMockPinRepo(): PersonalMemoryPinRepository {
  const pins = new Map<string, PersonalMemoryPin>();
  let sequence = 0;

  return {
    create: vi.fn((input) => {
      sequence += 1;
      const pin: PersonalMemoryPin = {
        id: `pin-${sequence}`,
        userId: input.userId,
        sourceMessageId: input.sourceMessageId,
        conversationId: input.conversationId,
        content: input.content,
        createdAt: `2026-05-0${sequence}T12:00:00.000Z`,
      };
      pins.set(pin.id, pin);
      return pin;
    }),
    findBySourceMessageId: vi.fn((userId, sourceMessageId) => {
      for (const pin of pins.values()) {
        if (pin.userId === userId && pin.sourceMessageId === sourceMessageId) {
          return pin;
        }
      }
      return null;
    }),
    list: vi.fn((userId, limit) => {
      return Array.from(pins.values())
        .filter((pin) => pin.userId === userId)
        .slice(0, limit);
    }),
    search: vi.fn((userId, query, limit) => {
      const q = query.toLowerCase();
      return Array.from(pins.values())
        .filter((pin) => pin.userId === userId)
        .filter((pin) => pin.content.toLowerCase().includes(q))
        .slice(0, limit);
    }),
    delete: vi.fn((id, userId) => {
      const existing = pins.get(id);
      if (!existing || existing.userId !== userId) {
        return false;
      }
      pins.delete(id);
      return true;
    }),
  };
}

function createDeps(overrides: Partial<MemoryRouteDeps> = {}): MemoryRouteDeps {
  return {
    personalMemoryNoteRepo: createMockNoteRepo(),
    personalMemoryPinRepo: createMockPinRepo(),
    docMemoryProvider: null,
    logger: createMockLogger(),
    ...overrides,
  };
}

function createApp(deps: MemoryRouteDeps, userId = "u1"): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = userId;
    next();
  });
  app.use("/api/memory", createMemoryRouter(deps));
  return app;
}

describe("Memory Route", () => {
  let deps: MemoryRouteDeps;
  let app: express.Express;

  beforeEach(() => {
    deps = createDeps();
    app = createApp(deps);
  });

  it("creates and lists notes", async () => {
    const createRes = await request(app).post("/api/memory/notes").send({
      title: "My style note",
      content: "Keep responses concise but warm.",
      tags: ["style", "voice"],
      pinned: true,
    });

    expect(createRes.status).toBe(201);
    expect(createRes.body.note.title).toBe("My style note");
    expect(createRes.body.note.tags).toBe('["style","voice"]');

    const listRes = await request(app).get("/api/memory/notes");
    expect(listRes.status).toBe(200);
    expect(listRes.body.items).toHaveLength(1);
    expect(listRes.body.items[0].title).toBe("My style note");
  });

  it("updates and deletes notes", async () => {
    const createRes = await request(app).post("/api/memory/notes").send({
      title: "Draft",
      content: "Original",
      tags: ["general"],
    });

    const noteId = createRes.body.note.id;
    const patchRes = await request(app)
      .patch(`/api/memory/notes/${noteId}`)
      .send({
        content: "Updated",
        pinned: true,
      });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.note.content).toBe("Updated");
    expect(patchRes.body.note.pinned).toBe(true);

    const deleteRes = await request(app).delete(`/api/memory/notes/${noteId}`);
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.success).toBe(true);
  });

  it("deduplicates pins by sourceMessageId", async () => {
    const first = await request(app).post("/api/memory/pins").send({
      content: "Pinned output",
      sourceMessageId: "assistant-msg-1",
      conversationId: "conv-1",
    });

    expect(first.status).toBe(201);
    expect(first.body.deduped).toBe(false);

    const second = await request(app).post("/api/memory/pins").send({
      content: "Pinned output edited",
      sourceMessageId: "assistant-msg-1",
      conversationId: "conv-1",
    });

    expect(second.status).toBe(200);
    expect(second.body.deduped).toBe(true);
    expect(second.body.pin.id).toBe(first.body.pin.id);
  });

  it("searches across notes, pins, and docs", async () => {
    await request(app).post("/api/memory/notes").send({
      title: "Voice preference",
      content: "Friendly but direct tone",
      tags: ["style"],
    });

    await request(app).post("/api/memory/pins").send({
      content: "Assistant said to propose short actionable next steps",
      sourceMessageId: "assistant-msg-2",
      conversationId: "conv-2",
    });

    const docMemoryProvider: PersonalDocMemoryProvider = {
      search: vi.fn(() => [
        {
          id: "doc:docs/style.md",
          title: "docs/style.md",
          snippet: "Team writing style guide",
          score: 0.6,
          path: "docs/style.md",
        },
      ]),
    };

    app = createApp(
      createDeps({
        personalMemoryNoteRepo: deps.personalMemoryNoteRepo,
        personalMemoryPinRepo: deps.personalMemoryPinRepo,
        docMemoryProvider,
      }),
    );

    const res = await request(app).get(
      "/api/memory/search?q=style&includeNotes=true&includePins=true&includeDocs=true&limit=5",
    );

    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    const sources = new Set(res.body.items.map((item: { source: string }) => item.source));
    expect(sources.has("note") || sources.has("pin") || sources.has("doc")).toBe(true);
  });

  it("returns 400 for invalid search input", async () => {
    const res = await request(app).get("/api/memory/search?q=");
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("q");
  });
});
