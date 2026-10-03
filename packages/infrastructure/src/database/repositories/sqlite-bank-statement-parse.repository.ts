import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
  BankStatementParseRepository,
  BankStatementParseRun,
  BankStatementParsedMetadata,
  BankStatementParsedTransaction,
} from "@oneon/domain";

export class SqliteBankStatementParseRepository
  implements BankStatementParseRepository
{
  constructor(private readonly db: Database.Database) {}

  upsertMetadata(
    metadata: Omit<BankStatementParsedMetadata, "id" | "createdAt" | "updatedAt">,
  ): BankStatementParsedMetadata {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO bank_statement_metadata (
           id,
           statement_id,
           user_id,
           account_last4,
           statement_date,
           period_start,
           period_end,
           currency,
           opening_balance_minor,
           closing_balance_minor,
           parser_id,
           parser_version,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (statement_id) DO UPDATE SET
           user_id = excluded.user_id,
           account_last4 = excluded.account_last4,
           statement_date = excluded.statement_date,
           period_start = excluded.period_start,
           period_end = excluded.period_end,
           currency = excluded.currency,
           opening_balance_minor = excluded.opening_balance_minor,
           closing_balance_minor = excluded.closing_balance_minor,
           parser_id = excluded.parser_id,
           parser_version = excluded.parser_version,
           updated_at = excluded.updated_at`
      )
      .run(
        id,
        metadata.statementId,
        metadata.userId,
        metadata.accountLast4,
        metadata.statementDate,
        metadata.periodStart,
        metadata.periodEnd,
        metadata.currency,
        metadata.openingBalanceMinor,
        metadata.closingBalanceMinor,
        metadata.parserId,
        metadata.parserVersion,
        now,
        now,
      );

    return this.findMetadataByStatementId(metadata.statementId, metadata.userId)!;
  }

  replaceTransactions(
    statementId: string,
    transactions: Array<
      Omit<BankStatementParsedTransaction, "id" | "statementId" | "createdAt">
    >,
  ): BankStatementParsedTransaction[] {
    const now = new Date().toISOString();
    const rows: BankStatementParsedTransaction[] = [];

    const deleteStatementTransactions = this.db.prepare(
      "DELETE FROM bank_statement_transactions WHERE statement_id = ?",
    );

    const insertTransaction = this.db.prepare(
      `INSERT INTO bank_statement_transactions (
         id,
         statement_id,
         user_id,
         posted_at,
         description,
         amount_minor,
         balance_minor,
         dedupe_key,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this.db.transaction(() => {
      deleteStatementTransactions.run(statementId);

      for (const transaction of transactions) {
        const id = randomUUID();

        insertTransaction.run(
          id,
          statementId,
          transaction.userId,
          transaction.postedAt,
          transaction.description,
          transaction.amountMinor,
          transaction.balanceMinor,
          transaction.dedupeKey,
          now,
        );

        rows.push({
          id,
          statementId,
          userId: transaction.userId,
          postedAt: transaction.postedAt,
          description: transaction.description,
          amountMinor: transaction.amountMinor,
          balanceMinor: transaction.balanceMinor,
          dedupeKey: transaction.dedupeKey,
          createdAt: now,
        });
      }
    })();

    return rows;
  }

  recordParseRun(
    run: Omit<BankStatementParseRun, "id" | "createdAt">,
  ): BankStatementParseRun {
    const id = randomUUID();
    const createdAt = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO bank_statement_parse_runs (
           id,
           statement_id,
           user_id,
           stage,
           outcome,
           parser_id,
           parser_version,
           error_code,
           error_message,
           duration_ms,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        run.statementId,
        run.userId,
        run.stage,
        run.outcome,
        run.parserId,
        run.parserVersion,
        run.errorCode,
        run.errorMessage,
        run.durationMs,
        createdAt,
      );

    return {
      id,
      statementId: run.statementId,
      userId: run.userId,
      stage: run.stage,
      outcome: run.outcome,
      parserId: run.parserId,
      parserVersion: run.parserVersion,
      errorCode: run.errorCode,
      errorMessage: run.errorMessage,
      durationMs: run.durationMs,
      createdAt,
    };
  }

  countFailedRuns(
    statementId: string,
    stage: BankStatementParseRun["stage"],
  ): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) as count FROM bank_statement_parse_runs WHERE statement_id = ? AND stage = ? AND outcome = 'error'",
      )
      .get(statementId, stage) as { count: number };

    return row.count;
  }

  findMetadataByStatementId(
    statementId: string,
    userId: string,
  ): BankStatementParsedMetadata | null {
    const row = this.db
      .prepare(
        "SELECT * FROM bank_statement_metadata WHERE statement_id = ? AND user_id = ?",
      )
      .get(statementId, userId) as RawBankStatementParsedMetadata | undefined;

    return row ? mapMetadataRow(row) : null;
  }

  findTransactions(options: {
    userId: string;
    statementId?: string;
    searchText?: string;
    postedAtFrom?: string;
    postedAtTo?: string;
    limit: number;
  }): BankStatementParsedTransaction[] {
    const clauses: string[] = ["user_id = ?"];
    const params: unknown[] = [options.userId];

    if (options.statementId) {
      clauses.push("statement_id = ?");
      params.push(options.statementId);
    }

    if (options.searchText) {
      clauses.push("LOWER(description) LIKE ?");
      params.push(`%${options.searchText.toLowerCase()}%`);
    }

    if (options.postedAtFrom) {
      clauses.push("posted_at >= ?");
      params.push(options.postedAtFrom);
    }

    if (options.postedAtTo) {
      clauses.push("posted_at <= ?");
      params.push(options.postedAtTo);
    }

    params.push(options.limit);

    const rows = this.db
      .prepare(
        `SELECT *
         FROM bank_statement_transactions
         WHERE ${clauses.join(" AND ")}
         ORDER BY posted_at DESC, created_at DESC
         LIMIT ?`,
      )
      .all(...params) as RawBankStatementParsedTransaction[];

    return rows.map(mapTransactionRow);
  }

  findParseRuns(options: {
    statementId: string;
    userId: string;
    limit: number;
  }): BankStatementParseRun[] {
    const rows = this.db
      .prepare(
        `SELECT *
         FROM bank_statement_parse_runs
         WHERE statement_id = ? AND user_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(
        options.statementId,
        options.userId,
        options.limit,
      ) as RawBankStatementParseRun[];

    return rows.map(mapParseRunRow);
  }
}

interface RawBankStatementParsedMetadata {
  id: string;
  statement_id: string;
  user_id: string;
  account_last4: string;
  statement_date: string;
  period_start: string;
  period_end: string;
  currency: string;
  opening_balance_minor: number;
  closing_balance_minor: number;
  parser_id: string;
  parser_version: number;
  created_at: string;
  updated_at: string;
}

interface RawBankStatementParsedTransaction {
  id: string;
  statement_id: string;
  user_id: string;
  posted_at: string;
  description: string;
  amount_minor: number;
  balance_minor: number | null;
  dedupe_key: string;
  created_at: string;
}

interface RawBankStatementParseRun {
  id: string;
  statement_id: string;
  user_id: string;
  stage: "metadata" | "transactions";
  outcome: "success" | "error";
  parser_id: string | null;
  parser_version: number | null;
  error_code: string | null;
  error_message: string | null;
  duration_ms: number;
  created_at: string;
}

function mapMetadataRow(
  row: RawBankStatementParsedMetadata,
): BankStatementParsedMetadata {
  return {
    id: row.id,
    statementId: row.statement_id,
    userId: row.user_id,
    accountLast4: row.account_last4,
    statementDate: row.statement_date,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    currency: row.currency,
    openingBalanceMinor: row.opening_balance_minor,
    closingBalanceMinor: row.closing_balance_minor,
    parserId: row.parser_id,
    parserVersion: row.parser_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTransactionRow(
  row: RawBankStatementParsedTransaction,
): BankStatementParsedTransaction {
  return {
    id: row.id,
    statementId: row.statement_id,
    userId: row.user_id,
    postedAt: row.posted_at,
    description: row.description,
    amountMinor: row.amount_minor,
    balanceMinor: row.balance_minor,
    dedupeKey: row.dedupe_key,
    createdAt: row.created_at,
  };
}

function mapParseRunRow(
  row: RawBankStatementParseRun,
): BankStatementParseRun {
  return {
    id: row.id,
    statementId: row.statement_id,
    userId: row.user_id,
    stage: row.stage,
    outcome: row.outcome,
    parserId: row.parser_id,
    parserVersion: row.parser_version,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
  };
}
