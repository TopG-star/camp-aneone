import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, relative, extname } from "node:path";
import type {
  PersonalDocMemoryProvider,
  PersonalDocSearchResult,
} from "@oneon/application";

export interface LocalDocMemoryProviderOptions {
  roots: string[];
  maxFiles: number;
}

export class LocalDocMemoryProvider implements PersonalDocMemoryProvider {
  private readonly absoluteRoots: string[];
  private readonly maxFiles: number;

  constructor(options: LocalDocMemoryProviderOptions) {
    this.absoluteRoots = options.roots.map((root) => resolve(process.cwd(), root));
    this.maxFiles = options.maxFiles;
  }

  search(query: string, limit: number): PersonalDocSearchResult[] {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return [];
    }

    const files = this.collectMarkdownFiles();
    const hits: PersonalDocSearchResult[] = [];

    for (const filePath of files) {
      const stat = statSync(filePath, { throwIfNoEntry: false });
      if (!stat || !stat.isFile()) {
        continue;
      }

      const raw = readFileSync(filePath, "utf-8");
      const text = raw.replace(/\s+/g, " ").trim();
      if (!text) {
        continue;
      }

      const score = lexicalScore(normalizedQuery, text);
      if (score <= 0) {
        continue;
      }

      const rel = relative(process.cwd(), filePath).replace(/\\/g, "/");
      hits.push({
        id: `doc:${rel}`,
        title: rel,
        snippet: buildSnippet(text, normalizedQuery),
        score,
        path: rel,
      });
    }

    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  private collectMarkdownFiles(): string[] {
    const out: string[] = [];

    for (const root of this.absoluteRoots) {
      if (out.length >= this.maxFiles) {
        break;
      }
      walk(root, out, this.maxFiles);
    }

    return out;
  }
}

function walk(dirPath: string, out: string[], maxFiles: number): void {
  if (out.length >= maxFiles) {
    return;
  }

  let entries;
  try {
    entries = readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= maxFiles) {
      return;
    }

    if (entry.name.startsWith(".")) {
      continue;
    }

    const next = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      walk(next, out, maxFiles);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const ext = extname(entry.name).toLowerCase();
    if (ext === ".md") {
      out.push(next);
    }
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
  if (text.length <= 220) {
    return text;
  }

  const index = text.toLowerCase().indexOf(query);
  if (index === -1) {
    return `${text.slice(0, 217)}...`;
  }

  const start = Math.max(0, index - 80);
  const end = Math.min(text.length, start + 220);
  const window = text.slice(start, end).trim();
  if (start > 0 || end < text.length) {
    return `...${window}...`;
  }

  return window;
}
