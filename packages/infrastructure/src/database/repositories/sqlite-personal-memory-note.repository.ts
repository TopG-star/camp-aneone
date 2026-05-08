import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
  PersonalMemoryNote,
  PersonalMemoryNoteRepository,
} from "@oneon/domain";

export class SqlitePersonalMemoryNoteRepository
  implements PersonalMemoryNoteRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: {
    userId: string;
    title: string;
    content: string;
    tags: string;
    pinned: boolean;
  }): PersonalMemoryNote {
    const id = randomUUID();

    this.db
      .prepare(
        `INSERT INTO personal_memory_notes (
           id, user_id, title, content, tags, pinned, created_at, updated_at
         ) VALUES (
           ?, ?, ?, ?, ?, ?,
           strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         )`,
      )
      .run(id, input.userId, input.title, input.content, input.tags, input.pinned ? 1 : 0);

    return this.findById(id, input.userId)!;
  }

  findById(id: string, userId: string): PersonalMemoryNote | null {
    const row = this.db
      .prepare(
        `SELECT id, user_id, title, content, tags, pinned, created_at, updated_at
         FROM personal_memory_notes
         WHERE id = ? AND user_id = ?`,
      )
      .get(id, userId) as RawPersonalMemoryNote | undefined;

    return row ? mapRow(row) : null;
  }

  list(userId: string, limit: number): PersonalMemoryNote[] {
    const rows = this.db
      .prepare(
        `SELECT id, user_id, title, content, tags, pinned, created_at, updated_at
         FROM personal_memory_notes
         WHERE user_id = ?
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(userId, limit) as RawPersonalMemoryNote[];

    return rows.map(mapRow);
  }

  search(userId: string, query: string, limit: number): PersonalMemoryNote[] {
    const like = `%${query.toLowerCase()}%`;
    const rows = this.db
      .prepare(
        `SELECT id, user_id, title, content, tags, pinned, created_at, updated_at
         FROM personal_memory_notes
         WHERE user_id = ?
           AND (
             lower(title) LIKE ? OR
             lower(content) LIKE ? OR
             lower(tags) LIKE ?
           )
         ORDER BY pinned DESC, updated_at DESC
         LIMIT ?`,
      )
      .all(userId, like, like, like, limit) as RawPersonalMemoryNote[];

    return rows.map(mapRow);
  }

  update(
    id: string,
    userId: string,
    patch: {
      title?: string;
      content?: string;
      tags?: string;
      pinned?: boolean;
    },
  ): PersonalMemoryNote | null {
    const existing = this.findById(id, userId);
    if (!existing) {
      return null;
    }

    const nextTitle = patch.title ?? existing.title;
    const nextContent = patch.content ?? existing.content;
    const nextTags = patch.tags ?? existing.tags;
    const nextPinned = patch.pinned ?? existing.pinned;

    this.db
      .prepare(
        `UPDATE personal_memory_notes
         SET title = ?,
             content = ?,
             tags = ?,
             pinned = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND user_id = ?`,
      )
      .run(nextTitle, nextContent, nextTags, nextPinned ? 1 : 0, id, userId);

    return this.findById(id, userId);
  }

  delete(id: string, userId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM personal_memory_notes WHERE id = ? AND user_id = ?")
      .run(id, userId);

    return result.changes > 0;
  }
}

interface RawPersonalMemoryNote {
  id: string;
  user_id: string;
  title: string;
  content: string;
  tags: string;
  pinned: number;
  created_at: string;
  updated_at: string;
}

function mapRow(row: RawPersonalMemoryNote): PersonalMemoryNote {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    content: row.content,
    tags: row.tags,
    pinned: row.pinned === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
