import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
  PersonalMemoryPin,
  PersonalMemoryPinRepository,
} from "@oneon/domain";

export class SqlitePersonalMemoryPinRepository
  implements PersonalMemoryPinRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: {
    userId: string;
    sourceMessageId: string | null;
    conversationId: string | null;
    content: string;
  }): PersonalMemoryPin {
    const id = randomUUID();

    this.db
      .prepare(
        `INSERT INTO personal_memory_pins (
           id,
           user_id,
           source_message_id,
           conversation_id,
           content,
           created_at
         ) VALUES (
           ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         )`,
      )
      .run(
        id,
        input.userId,
        input.sourceMessageId,
        input.conversationId,
        input.content,
      );

    return this.findById(id, input.userId)!;
  }

  findBySourceMessageId(
    userId: string,
    sourceMessageId: string,
  ): PersonalMemoryPin | null {
    const row = this.db
      .prepare(
        `SELECT id, user_id, source_message_id, conversation_id, content, created_at
         FROM personal_memory_pins
         WHERE user_id = ? AND source_message_id = ?`,
      )
      .get(userId, sourceMessageId) as RawPersonalMemoryPin | undefined;

    return row ? mapRow(row) : null;
  }

  list(userId: string, limit: number): PersonalMemoryPin[] {
    const rows = this.db
      .prepare(
        `SELECT id, user_id, source_message_id, conversation_id, content, created_at
         FROM personal_memory_pins
         WHERE user_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(userId, limit) as RawPersonalMemoryPin[];

    return rows.map(mapRow);
  }

  search(userId: string, query: string, limit: number): PersonalMemoryPin[] {
    const like = `%${query.toLowerCase()}%`;
    const rows = this.db
      .prepare(
        `SELECT id, user_id, source_message_id, conversation_id, content, created_at
         FROM personal_memory_pins
         WHERE user_id = ?
           AND lower(content) LIKE ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(userId, like, limit) as RawPersonalMemoryPin[];

    return rows.map(mapRow);
  }

  delete(id: string, userId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM personal_memory_pins WHERE id = ? AND user_id = ?")
      .run(id, userId);

    return result.changes > 0;
  }

  private findById(id: string, userId: string): PersonalMemoryPin | null {
    const row = this.db
      .prepare(
        `SELECT id, user_id, source_message_id, conversation_id, content, created_at
         FROM personal_memory_pins
         WHERE id = ? AND user_id = ?`,
      )
      .get(id, userId) as RawPersonalMemoryPin | undefined;

    return row ? mapRow(row) : null;
  }
}

interface RawPersonalMemoryPin {
  id: string;
  user_id: string;
  source_message_id: string | null;
  conversation_id: string | null;
  content: string;
  created_at: string;
}

function mapRow(row: RawPersonalMemoryPin): PersonalMemoryPin {
  return {
    id: row.id,
    userId: row.user_id,
    sourceMessageId: row.source_message_id,
    conversationId: row.conversation_id,
    content: row.content,
    createdAt: row.created_at,
  };
}
