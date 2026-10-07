import { z } from "zod";
import type {
  PersonalMemoryNoteRepository,
  PersonalMemoryPinRepository,
} from "@oneon/domain";
import type { ToolDefinition, ToolResult } from "./tool-registry.js";

export const searchPersonalMemorySchema = z.object({
  query: z.string().trim().min(1),
  limit: z.number().int().positive().max(30).optional().default(10),
  includeNotes: z.boolean().optional().default(true),
  includePins: z.boolean().optional().default(true),
  includeDocs: z.boolean().optional().default(true),
  userId: z.string().trim().min(1),
});

export type SearchPersonalMemoryInput = z.infer<typeof searchPersonalMemorySchema>;

export type PersonalMemorySource = "note" | "pin" | "doc";

export interface PersonalMemoryHit {
  id: string;
  source: PersonalMemorySource;
  title: string;
  snippet: string;
  score: number;
  createdAt: string | null;
  metadata: Record<string, unknown>;
}

export interface PersonalDocSearchResult {
  id: string;
  title: string;
  snippet: string;
  score: number;
  path: string;
}

export interface PersonalDocMemoryProvider {
  search(query: string, limit: number): PersonalDocSearchResult[];
}

export interface SearchPersonalMemoryDeps {
  personalMemoryNoteRepo: Pick<PersonalMemoryNoteRepository, "search">;
  personalMemoryPinRepo: Pick<PersonalMemoryPinRepository, "search">;
  docMemoryProvider?: PersonalDocMemoryProvider | null;
}

export function createSearchPersonalMemoryTool(
  deps: SearchPersonalMemoryDeps,
): ToolDefinition {
  return {
    name: "search_personal_memory",
    version: "1.0.0",
    description:
      "Retrieve relevant personal notes, pinned outputs, and curated docs to ground responses.",
    inputSchema: searchPersonalMemorySchema,
    execute(validatedInput: unknown): ToolResult {
      const input = validatedInput as SearchPersonalMemoryInput;
      const hits = retrievePersonalMemory(deps, input);

      return {
        data: hits,
        summary:
          hits.length === 0
            ? `No personal memory matches found for "${input.query}".`
            : `Found ${hits.length} personal memory match${hits.length === 1 ? "" : "es"} for "${input.query}".`,
      };
    },
  };
}

export function retrievePersonalMemory(
  deps: SearchPersonalMemoryDeps,
  input: SearchPersonalMemoryInput,
): PersonalMemoryHit[] {
  const normalizedQuery = input.query.trim().toLowerCase();
  const baseLimit = Math.max(1, Math.min(input.limit, 30));

  const hits: PersonalMemoryHit[] = [];

  if (input.includeNotes) {
    const notes = deps.personalMemoryNoteRepo.search(
      input.userId,
      normalizedQuery,
      Math.max(baseLimit * 2, 15),
    );

    for (const note of notes) {
      const snippet = buildSnippet(note.content, normalizedQuery);
      const styleBoost = shouldBoostStyle(normalizedQuery, note.tags) ? 0.25 : 0;
      hits.push({
        id: note.id,
        source: "note",
        title: note.title,
        snippet,
        score: 1 + styleBoost + lexicalScore(normalizedQuery, `${note.title} ${note.content}`),
        createdAt: note.updatedAt,
        metadata: {
          pinned: note.pinned,
          tags: note.tags,
        },
      });
    }
  }

  if (input.includePins) {
    const pins = deps.personalMemoryPinRepo.search(
      input.userId,
      normalizedQuery,
      Math.max(baseLimit * 2, 15),
    );

    for (const pin of pins) {
      hits.push({
        id: pin.id,
        source: "pin",
        title: "Pinned assistant output",
        snippet: buildSnippet(pin.content, normalizedQuery),
        score: 0.9 + lexicalScore(normalizedQuery, pin.content),
        createdAt: pin.createdAt,
        metadata: {
          sourceMessageId: pin.sourceMessageId,
          conversationId: pin.conversationId,
        },
      });
    }
  }

  if (input.includeDocs && deps.docMemoryProvider) {
    const docs = deps.docMemoryProvider.search(normalizedQuery, Math.max(baseLimit * 2, 15));
    for (const doc of docs) {
      hits.push({
        id: doc.id,
        source: "doc",
        title: doc.title,
        snippet: doc.snippet,
        score: 0.75 + doc.score,
        createdAt: null,
        metadata: {
          path: doc.path,
        },
      });
    }
  }

  return hits
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      if (a.createdAt && b.createdAt) {
        return b.createdAt.localeCompare(a.createdAt);
      }
      if (a.createdAt) return -1;
      if (b.createdAt) return 1;
      return a.title.localeCompare(b.title);
    })
    .slice(0, baseLimit);
}

function shouldBoostStyle(query: string, tagsJson: string): boolean {
  if (!/(style|tone|voice|write|writing|respond|response)/.test(query)) {
    return false;
  }

  try {
    const tags = JSON.parse(tagsJson);
    if (!Array.isArray(tags)) {
      return false;
    }

    return tags.some(
      (value) =>
        typeof value === "string" &&
        ["style", "voice", "writing", "persona"].includes(value.toLowerCase()),
    );
  } catch {
    return false;
  }
}

function lexicalScore(query: string, text: string): number {
  const tokens = query
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);

  if (tokens.length === 0) {
    return 0;
  }

  const normalized = text.toLowerCase();
  let matched = 0;
  for (const token of tokens) {
    if (normalized.includes(token)) {
      matched += 1;
    }
  }

  return matched / tokens.length;
}

function buildSnippet(text: string, query: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= 220) {
    return trimmed;
  }

  const index = trimmed.toLowerCase().indexOf(query);
  if (index === -1) {
    return `${trimmed.slice(0, 217)}...`;
  }

  const start = Math.max(0, index - 80);
  const end = Math.min(trimmed.length, start + 220);
  const window = trimmed.slice(start, end).trim();
  if (start > 0 || end < trimmed.length) {
    return `...${window}...`;
  }

  return window;
}
