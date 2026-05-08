import { Router, type Request, type Response } from "express";
import { retrievePersonalMemory, type PersonalDocMemoryProvider } from "@oneon/application";
import type {
  Logger,
  PersonalMemoryNoteRepository,
  PersonalMemoryPinRepository,
} from "@oneon/domain";

export interface MemoryRouteDeps {
  personalMemoryNoteRepo: PersonalMemoryNoteRepository;
  personalMemoryPinRepo: PersonalMemoryPinRepository;
  docMemoryProvider?: PersonalDocMemoryProvider | null;
  logger: Logger;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export function createMemoryRouter(deps: MemoryRouteDeps): Router {
  const router = Router();
  const {
    personalMemoryNoteRepo,
    personalMemoryPinRepo,
    docMemoryProvider,
    logger,
  } = deps;

  router.get("/notes", (req: Request, res: Response) => {
    try {
      const userId = req.userId!;
      const limit = parseLimit(req.query.limit, DEFAULT_LIMIT, MAX_LIMIT);
      if (!limit.ok) {
        res.status(400).json({ error: limit.error });
        return;
      }

      const items = personalMemoryNoteRepo.list(userId, limit.value);
      res.status(200).json({ items, limit: limit.value });
    } catch (error) {
      logger.error("Failed to list personal memory notes", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/notes", (req: Request, res: Response) => {
    try {
      const userId = req.userId!;
      const parsed = parseCreateNotePayload(req.body);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error });
        return;
      }

      const created = personalMemoryNoteRepo.create({
        userId,
        title: parsed.value.title,
        content: parsed.value.content,
        tags: JSON.stringify(parsed.value.tags),
        pinned: parsed.value.pinned,
      });

      res.status(201).json({ note: created });
    } catch (error) {
      logger.error("Failed to create personal memory note", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.patch("/notes/:id", (req: Request, res: Response) => {
    try {
      const userId = req.userId!;
      const noteId = String(req.params.id ?? "").trim();
      if (!noteId) {
        res.status(400).json({ error: "noteId is required" });
        return;
      }

      const parsed = parseUpdateNotePayload(req.body);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error });
        return;
      }

      const updated = personalMemoryNoteRepo.update(noteId, userId, {
        title: parsed.value.title,
        content: parsed.value.content,
        tags: parsed.value.tags ? JSON.stringify(parsed.value.tags) : undefined,
        pinned: parsed.value.pinned,
      });

      if (!updated) {
        res.status(404).json({ error: "Note not found" });
        return;
      }

      res.status(200).json({ note: updated });
    } catch (error) {
      logger.error("Failed to update personal memory note", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.delete("/notes/:id", (req: Request, res: Response) => {
    try {
      const userId = req.userId!;
      const noteId = String(req.params.id ?? "").trim();
      if (!noteId) {
        res.status(400).json({ error: "noteId is required" });
        return;
      }

      const deleted = personalMemoryNoteRepo.delete(noteId, userId);
      if (!deleted) {
        res.status(404).json({ error: "Note not found" });
        return;
      }

      res.status(200).json({ success: true });
    } catch (error) {
      logger.error("Failed to delete personal memory note", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/pins", (req: Request, res: Response) => {
    try {
      const userId = req.userId!;
      const limit = parseLimit(req.query.limit, DEFAULT_LIMIT, MAX_LIMIT);
      if (!limit.ok) {
        res.status(400).json({ error: limit.error });
        return;
      }

      const items = personalMemoryPinRepo.list(userId, limit.value);
      res.status(200).json({ items, limit: limit.value });
    } catch (error) {
      logger.error("Failed to list personal memory pins", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/pins", (req: Request, res: Response) => {
    try {
      const userId = req.userId!;
      const parsed = parseCreatePinPayload(req.body);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error });
        return;
      }

      if (parsed.value.sourceMessageId) {
        const existing = personalMemoryPinRepo.findBySourceMessageId(
          userId,
          parsed.value.sourceMessageId,
        );
        if (existing) {
          res.status(200).json({ pin: existing, deduped: true });
          return;
        }
      }

      const created = personalMemoryPinRepo.create({
        userId,
        sourceMessageId: parsed.value.sourceMessageId,
        conversationId: parsed.value.conversationId,
        content: parsed.value.content,
      });

      res.status(201).json({ pin: created, deduped: false });
    } catch (error) {
      logger.error("Failed to create personal memory pin", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.delete("/pins/:id", (req: Request, res: Response) => {
    try {
      const userId = req.userId!;
      const pinId = String(req.params.id ?? "").trim();
      if (!pinId) {
        res.status(400).json({ error: "pinId is required" });
        return;
      }

      const deleted = personalMemoryPinRepo.delete(pinId, userId);
      if (!deleted) {
        res.status(404).json({ error: "Pin not found" });
        return;
      }

      res.status(200).json({ success: true });
    } catch (error) {
      logger.error("Failed to delete personal memory pin", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/search", (req: Request, res: Response) => {
    try {
      const userId = req.userId!;
      const query = parseRequiredText(req.query.q, "q");
      if (!query.ok) {
        res.status(400).json({ error: query.error });
        return;
      }

      const limit = parseLimit(req.query.limit, 10, 30);
      if (!limit.ok) {
        res.status(400).json({ error: limit.error });
        return;
      }

      const includeNotes = parseBoolean(req.query.includeNotes, true);
      if (!includeNotes.ok) {
        res.status(400).json({ error: includeNotes.error });
        return;
      }

      const includePins = parseBoolean(req.query.includePins, true);
      if (!includePins.ok) {
        res.status(400).json({ error: includePins.error });
        return;
      }

      const includeDocs = parseBoolean(req.query.includeDocs, true);
      if (!includeDocs.ok) {
        res.status(400).json({ error: includeDocs.error });
        return;
      }

      const items = retrievePersonalMemory(
        {
          personalMemoryNoteRepo,
          personalMemoryPinRepo,
          docMemoryProvider,
        },
        {
          query: query.value,
          userId,
          limit: limit.value,
          includeNotes: includeNotes.value,
          includePins: includePins.value,
          includeDocs: includeDocs.value,
        },
      );

      res.status(200).json({
        query: query.value,
        items,
      });
    } catch (error) {
      logger.error("Failed to search personal memory", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

function parseLimit(
  value: Request["query"]["limit"],
  fallback: number,
  max: number,
): { ok: true; value: number } | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true, value: fallback };
  }

  if (Array.isArray(value) || typeof value !== "string") {
    return { ok: false, error: `limit must be a number between 1 and ${max}` };
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    return { ok: false, error: `limit must be a number between 1 and ${max}` };
  }

  return { ok: true, value: parsed };
}

function parseBoolean(
  value: Request["query"]["includeNotes"],
  fallback: boolean,
): { ok: true; value: boolean } | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true, value: fallback };
  }

  if (Array.isArray(value) || typeof value !== "string") {
    return { ok: false, error: "boolean query parameters must be true or false" };
  }

  if (value === "true") {
    return { ok: true, value: true };
  }

  if (value === "false") {
    return { ok: true, value: false };
  }

  return { ok: false, error: "boolean query parameters must be true or false" };
}

function parseRequiredText(
  value: Request["query"]["q"],
  field: string,
): { ok: true; value: string } | { ok: false; error: string } {
  if (Array.isArray(value) || typeof value !== "string") {
    return { ok: false, error: `${field} must be a non-empty string` };
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: false, error: `${field} must be a non-empty string` };
  }

  return { ok: true, value: trimmed };
}

function parseCreateNotePayload(
  raw: unknown,
):
  | {
      ok: true;
      value: { title: string; content: string; tags: string[]; pinned: boolean };
    }
  | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "payload must be an object" };
  }

  const input = raw as Record<string, unknown>;
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const content = typeof input.content === "string" ? input.content.trim() : "";

  if (!title) {
    return { ok: false, error: "title is required" };
  }
  if (!content) {
    return { ok: false, error: "content is required" };
  }

  const tags = parseTags(input.tags);
  if (!tags.ok) {
    return tags;
  }

  const pinned = typeof input.pinned === "boolean" ? input.pinned : false;

  return {
    ok: true,
    value: {
      title,
      content,
      tags: tags.value,
      pinned,
    },
  };
}

function parseUpdateNotePayload(
  raw: unknown,
):
  | {
      ok: true;
      value: {
        title?: string;
        content?: string;
        tags?: string[];
        pinned?: boolean;
      };
    }
  | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "payload must be an object" };
  }

  const input = raw as Record<string, unknown>;
  const patch: {
    title?: string;
    content?: string;
    tags?: string[];
    pinned?: boolean;
  } = {};

  if (Object.prototype.hasOwnProperty.call(input, "title")) {
    if (typeof input.title !== "string" || input.title.trim() === "") {
      return { ok: false, error: "title must be a non-empty string" };
    }
    patch.title = input.title.trim();
  }

  if (Object.prototype.hasOwnProperty.call(input, "content")) {
    if (typeof input.content !== "string" || input.content.trim() === "") {
      return { ok: false, error: "content must be a non-empty string" };
    }
    patch.content = input.content.trim();
  }

  if (Object.prototype.hasOwnProperty.call(input, "tags")) {
    const tags = parseTags(input.tags);
    if (!tags.ok) {
      return tags;
    }
    patch.tags = tags.value;
  }

  if (Object.prototype.hasOwnProperty.call(input, "pinned")) {
    if (typeof input.pinned !== "boolean") {
      return { ok: false, error: "pinned must be a boolean" };
    }
    patch.pinned = input.pinned;
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, error: "at least one field is required" };
  }

  return { ok: true, value: patch };
}

function parseCreatePinPayload(
  raw: unknown,
):
  | {
      ok: true;
      value: {
        content: string;
        sourceMessageId: string | null;
        conversationId: string | null;
      };
    }
  | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "payload must be an object" };
  }

  const input = raw as Record<string, unknown>;
  const content = typeof input.content === "string" ? input.content.trim() : "";
  if (!content) {
    return { ok: false, error: "content is required" };
  }

  const sourceMessageId =
    typeof input.sourceMessageId === "string" && input.sourceMessageId.trim() !== ""
      ? input.sourceMessageId.trim()
      : null;

  const conversationId =
    typeof input.conversationId === "string" && input.conversationId.trim() !== ""
      ? input.conversationId.trim()
      : null;

  return {
    ok: true,
    value: {
      content,
      sourceMessageId,
      conversationId,
    },
  };
}

function parseTags(value: unknown): { ok: true; value: string[] } | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true, value: [] };
  }

  if (!Array.isArray(value)) {
    return { ok: false, error: "tags must be an array of strings" };
  }

  const normalized: string[] = [];
  for (const tag of value) {
    if (typeof tag !== "string") {
      return { ok: false, error: "tags must be an array of strings" };
    }

    const trimmed = tag.trim();
    if (!trimmed) {
      continue;
    }
    normalized.push(trimmed);
  }

  return { ok: true, value: normalized.slice(0, 20) };
}
