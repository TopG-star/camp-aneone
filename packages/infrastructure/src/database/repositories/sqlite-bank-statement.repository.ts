import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
  BankStatement,
  BankStatementIntakeStatus,
  BankStatementRepository,
  Source,
} from "@oneon/domain";

export class SqliteBankStatementRepository implements BankStatementRepository {
  constructor(private readonly db: Database.Database) {}

  upsert(
    statement: Omit<BankStatement, "id" | "createdAt" | "updatedAt">
  ): BankStatement {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO bank_statements (id, user_id, source, external_id, message_id, thread_id, sender, sender_domain, subject, received_at, status, detection_rule_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, source, external_id) DO UPDATE SET
           message_id             = excluded.message_id,
           thread_id              = excluded.thread_id,
           sender                 = excluded.sender,
           sender_domain          = excluded.sender_domain,
           subject                = excluded.subject,
           received_at            = excluded.received_at,
           detection_rule_version = excluded.detection_rule_version,
           updated_at             = excluded.updated_at`
      )
      .run(
        id,
        statement.userId,
        statement.source,
        statement.externalId,
        statement.messageId,
        statement.threadId,
        statement.sender,
        statement.senderDomain,
        statement.subject,
        statement.receivedAt,
        statement.status,
        statement.detectionRuleVersion,
        now,
        now,
      );

    return this.findBySourceAndExternalId(
      statement.source,
      statement.externalId,
      statement.userId,
    )!;
  }

  findById(id: string): BankStatement | null {
    const row = this.db
      .prepare("SELECT * FROM bank_statements WHERE id = ?")
      .get(id) as RawBankStatement | undefined;
    return row ? mapRow(row) : null;
  }

  findBySourceAndExternalId(
    source: Source,
    externalId: string,
    userId?: string,
  ): BankStatement | null {
    let sql = "SELECT * FROM bank_statements WHERE source = ? AND external_id = ?";
    const params: unknown[] = [source, externalId];
    if (userId) {
      sql += " AND user_id = ?";
      params.push(userId);
    }
    const row = this.db.prepare(sql).get(...params) as RawBankStatement | undefined;
    return row ? mapRow(row) : null;
  }

  findByStatus(
    status: BankStatementIntakeStatus,
    limit: number,
    userId?: string,
  ): BankStatement[] {
    let sql = "SELECT * FROM bank_statements WHERE status = ?";
    const params: unknown[] = [status];

    if (userId) {
      sql += " AND user_id = ?";
      params.push(userId);
    }

    sql += " ORDER BY received_at DESC LIMIT ?";
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as RawBankStatement[];
    return rows.map(mapRow);
  }

  markMetadataParsed(id: string): void {
    this.transitionStatus(id, "discovered", "metadata_parsed");
  }

  markErrorMetadata(id: string): void {
    this.transitionStatus(id, "discovered", "error_metadata");
  }

  markTransactionsParsed(id: string): void {
    this.transitionStatus(id, "metadata_parsed", "transactions_parsed");
  }

  markTransactionsError(id: string): void {
    this.transitionStatus(id, "metadata_parsed", "error_transactions");
  }

  count(options?: {
    status?: BankStatementIntakeStatus;
    userId?: string;
  }): number {
    let sql = "SELECT COUNT(*) as count FROM bank_statements WHERE 1=1";
    const params: unknown[] = [];

    if (options?.status) {
      sql += " AND status = ?";
      params.push(options.status);
    }
    if (options?.userId) {
      sql += " AND user_id = ?";
      params.push(options.userId);
    }

    const row = this.db.prepare(sql).get(...params) as { count: number };
    return row.count;
  }

  private transitionStatus(
    id: string,
    from: BankStatementIntakeStatus,
    to: BankStatementIntakeStatus,
  ): void {
    const result = this.db
      .prepare(
        "UPDATE bank_statements SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND status = ?",
      )
      .run(to, id, from);

    if (result.changes > 0) {
      return;
    }

    const existing = this.findById(id);
    if (!existing) {
      throw new Error(`bank statement not found: ${id}`);
    }

    throw new Error(`invalid status transition: ${existing.status} -> ${to}`);
  }
}

interface RawBankStatement {
  id: string;
  user_id: string;
  source: string;
  external_id: string;
  message_id: string;
  thread_id: string | null;
  sender: string;
  sender_domain: string;
  subject: string;
  received_at: string;
  status: string;
  detection_rule_version: string;
  created_at: string;
  updated_at: string;
}

function mapRow(row: RawBankStatement): BankStatement {
  return {
    id: row.id,
    userId: row.user_id,
    source: row.source as Source,
    externalId: row.external_id,
    messageId: row.message_id,
    threadId: row.thread_id,
    sender: row.sender,
    senderDomain: row.sender_domain,
    subject: row.subject,
    receivedAt: row.received_at,
    status: row.status as BankStatementIntakeStatus,
    detectionRuleVersion: row.detection_rule_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
