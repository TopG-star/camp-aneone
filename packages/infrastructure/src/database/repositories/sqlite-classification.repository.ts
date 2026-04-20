import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
  Classification,
  ClassificationRepository,
  ClassificationFeedback,
  ClassificationFeedbackRepository,
  Category,
  Priority,
} from "@oneon/domain";

export class SqliteClassificationRepository
  implements ClassificationRepository
{
  constructor(private readonly db: Database.Database) {}

  create(
    classification: Omit<Classification, "id" | "createdAt">
  ): Classification {
    const id = randomUUID();

    this.db
      .prepare(
        `INSERT INTO classifications (id, inbound_item_id, category, priority, summary, action_items, follow_up_needed, model, prompt_version, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        classification.inboundItemId,
        classification.category,
        classification.priority,
        classification.summary,
        classification.actionItems,
        classification.followUpNeeded ? 1 : 0,
        classification.model,
        classification.promptVersion,
        classification.userId
      );

    return this.findByInboundItemId(classification.inboundItemId)!;
  }

  findByInboundItemId(inboundItemId: string): Classification | null {
    const row = this.db
      .prepare("SELECT * FROM classifications WHERE inbound_item_id = ?")
      .get(inboundItemId) as RawClassification | undefined;
    return row ? mapRow(row) : null;
  }

  findAll(options: {
    category?: Category;
    minPriority?: Priority;
    limit?: number;
    offset?: number;
    userId?: string;
  }): Classification[] {
    let sql = "SELECT * FROM classifications WHERE 1=1";
    const params: unknown[] = [];

    if (options.userId) {
      sql += " AND user_id = ?";
      params.push(options.userId);
    }
    if (options.category) {
      sql += " AND category = ?";
      params.push(options.category);
    }
    if (options.minPriority) {
      sql += " AND priority <= ?";
      params.push(options.minPriority);
    }

    sql += " ORDER BY created_at DESC";

    if (options.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(options.limit);
    }
    if (options.offset !== undefined) {
      sql += " OFFSET ?";
      params.push(options.offset);
    }

    const rows = this.db.prepare(sql).all(...params) as RawClassification[];
    return rows.map(mapRow);
  }

  count(options?: { category?: Category; userId?: string }): number {
    let sql = "SELECT COUNT(*) as count FROM classifications WHERE 1=1";
    const params: unknown[] = [];

    if (options?.userId) {
      sql += " AND user_id = ?";
      params.push(options.userId);
    }
    if (options?.category) {
      sql += " AND category = ?";
      params.push(options.category);
    }

    const row = this.db.prepare(sql).get(...params) as { count: number };
    return row.count;
  }
}

export class SqliteClassificationFeedbackRepository
  implements ClassificationFeedbackRepository
{
  constructor(private readonly db: Database.Database) {}

  create(
    feedback: Omit<ClassificationFeedback, "id" | "createdAt">
  ): ClassificationFeedback {
    const id = randomUUID();

    this.db
      .prepare(
        `INSERT INTO classification_feedback (id, classification_id, corrected_category, corrected_priority, notes)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        id,
        feedback.classificationId,
        feedback.correctedCategory,
        feedback.correctedPriority,
        feedback.notes
      );

    const row = this.db
      .prepare("SELECT * FROM classification_feedback WHERE id = ?")
      .get(id) as RawFeedback;
    return mapFeedbackRow(row);
  }

  findByClassificationId(
    classificationId: string
  ): ClassificationFeedback[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM classification_feedback WHERE classification_id = ? ORDER BY created_at DESC"
      )
      .all(classificationId) as RawFeedback[];
    return rows.map(mapFeedbackRow);
  }
}

// ── Internal row mapping ─────────────────────────────────────

interface RawClassification {
  id: string;
  inbound_item_id: string;
  category: string;
  priority: number;
  summary: string;
  action_items: string;
  follow_up_needed: number;
  model: string;
  prompt_version: string;
  user_id: string | null;
  created_at: string;
}

function mapRow(row: RawClassification): Classification {
  return {
    id: row.id,
    userId: row.user_id,
    inboundItemId: row.inbound_item_id,
    category: row.category as Category,
    priority: row.priority as Priority,
    summary: row.summary,
    actionItems: row.action_items,
    followUpNeeded: row.follow_up_needed === 1,
    model: row.model,
    promptVersion: row.prompt_version,
    createdAt: row.created_at,
  };
}

interface RawFeedback {
  id: string;
  classification_id: string;
  corrected_category: string | null;
  corrected_priority: number | null;
  notes: string | null;
  created_at: string;
}

function mapFeedbackRow(row: RawFeedback): ClassificationFeedback {
  return {
    id: row.id,
    classificationId: row.classification_id,
    correctedCategory: row.corrected_category as Category | null,
    correctedPriority: row.corrected_priority as Priority | null,
    notes: row.notes,
    createdAt: row.created_at,
  };
}
