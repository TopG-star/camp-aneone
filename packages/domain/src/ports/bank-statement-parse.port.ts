import type {
  BankStatement,
  BankStatementParseRun,
  BankStatementParsedMetadata,
  BankStatementParsedTransaction,
} from "../entities.js";

export interface StatementDocument {
  mimeType: string;
  content: Uint8Array;
  fileName?: string | null;
}

export interface BankStatementParser {
  id: string;
  version: number;
  parseMetadata(input: {
    statement: BankStatement;
    document: StatementDocument;
  }): Omit<BankStatementParsedMetadata, "id" | "statementId" | "userId" | "createdAt" | "updatedAt">;
  parseTransactions(input: {
    statement: BankStatement;
    document: StatementDocument;
    metadata?: Omit<BankStatementParsedMetadata, "id" | "statementId" | "userId" | "createdAt" | "updatedAt">;
  }): Array<
    Omit<BankStatementParsedTransaction, "id" | "statementId" | "userId" | "createdAt">
  >;
}

export interface BankStatementParserRegistry {
  resolve(statement: BankStatement): BankStatementParser | null;
}

export interface StatementDocumentProvider {
  getStatementDocument(statement: BankStatement): Promise<StatementDocument | null>;
}

export interface BankStatementParseRepository {
  upsertMetadata(
    metadata: Omit<BankStatementParsedMetadata, "id" | "createdAt" | "updatedAt">,
  ): BankStatementParsedMetadata;
  replaceTransactions(
    statementId: string,
    transactions: Array<
      Omit<BankStatementParsedTransaction, "id" | "statementId" | "createdAt">
    >,
  ): BankStatementParsedTransaction[];
  recordParseRun(
    run: Omit<BankStatementParseRun, "id" | "createdAt">,
  ): BankStatementParseRun;
  countFailedRuns(statementId: string, stage: BankStatementParseRun["stage"]): number;
}
