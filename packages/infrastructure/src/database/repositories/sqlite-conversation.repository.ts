import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
  ConversationMessage,
  ConversationRepository,
} from "@oneon/domain";

export class SqliteConversationRepository implements ConversationRepository {
  constructor(private readonly db: Database.Database) {}

  append(
    message: Omit<ConversationMessage, "id" | "createdAt">
  ): ConversationMessage {
    const id = randomUUID();

    this.db
      .prepare(
        `INSERT INTO conversations (id, conversation_id, role, content, tool_calls, user_id)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, message.conversationId, message.role, message.content, message.toolCalls, message.userId);

    const row = this.db
      .prepare("SELECT * FROM conversations WHERE id = ?")
      .get(id) as RawConversation;
    return mapRow(row);
  }

  findRecentByConversation(conversationId: string, limit: number, userId?: string): ConversationMessage[] {
    let whereExtra = "";
    const params: unknown[] = [conversationId];
    if (userId) {
      whereExtra = " AND user_id = ?";
      params.push(userId);
    }
    params.push(limit);
    const rows = this.db
      .prepare(
        `SELECT id, conversation_id, role, content, tool_calls, user_id, created_at FROM (
          SELECT *, _rowid_ AS rn FROM conversations
          WHERE conversation_id = ?${whereExtra}
          ORDER BY created_at DESC, rn DESC LIMIT ?
        ) ORDER BY created_at ASC, rn ASC`
      )
      .all(...params) as RawConversation[];
    return rows.map(mapRow);
  }

  countByConversation(conversationId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM conversations WHERE conversation_id = ?")
      .get(conversationId) as { count: number };
    return row.count;
  }

  count(userId?: string): number {
    if (userId) {
      const row = this.db
        .prepare("SELECT COUNT(*) as count FROM conversations WHERE user_id = ?")
        .get(userId) as { count: number };
      return row.count;
    }
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM conversations")
      .get() as { count: number };
    return row.count;
  }
}

// ── Internal row mapping ─────────────────────────────────────

interface RawConversation {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  tool_calls: string | null;
  user_id: string | null;
  created_at: string;
}

function mapRow(row: RawConversation): ConversationMessage {
  return {
    id: row.id,
    userId: row.user_id,
    conversationId: row.conversation_id,
    role: row.role as ConversationMessage["role"],
    content: row.content,
    toolCalls: row.tool_calls,
    createdAt: row.created_at,
  };
}
