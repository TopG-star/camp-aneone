import type {
  BankStatement,
  BankStatementParseRepository,
  BankStatementParser,
  BankStatementParserRegistry,
  BankStatementRepository,
  Logger,
  StatementDocumentProvider,
} from "@oneon/domain";

export interface ParseBankStatementsDeps {
  bankStatementRepo: Pick<
    BankStatementRepository,
    | "findByStatus"
    | "markMetadataParsed"
    | "markErrorMetadata"
    | "markTransactionsParsed"
    | "markTransactionsError"
  >;
  parseRepo: BankStatementParseRepository;
  parserRegistry: BankStatementParserRegistry;
  documentProvider: StatementDocumentProvider;
  logger: Logger;
}

export interface ParseBankStatementsOptions {
  userId: string;
  batchSize: number;
  maxTransactionRetries: number;
}

export interface ParseBankStatementsSummary {
  discoveredCandidates: number;
  transactionCandidates: number;
  transactionsParsed: number;
  errorMetadata: number;
  errorTransactions: number;
  skippedRetries: number;
}

const ERROR_CODES = {
  parserNotFound: "PARSER_NOT_FOUND",
  documentUnavailable: "DOCUMENT_UNAVAILABLE",
  metadataParseFailed: "METADATA_PARSE_FAILED",
  transactionParseFailed: "TRANSACTION_PARSE_FAILED",
} as const;

export async function parseBankStatements(
  deps: ParseBankStatementsDeps,
  options: ParseBankStatementsOptions,
): Promise<ParseBankStatementsSummary> {
  const discovered = deps.bankStatementRepo.findByStatus(
    "discovered",
    options.batchSize,
    options.userId,
  );
  const metadataParsed = deps.bankStatementRepo.findByStatus(
    "metadata_parsed",
    options.batchSize,
    options.userId,
  );
  const transactionFailures = deps.bankStatementRepo.findByStatus(
    "error_transactions",
    options.batchSize,
    options.userId,
  );

  const retryableFailures =
    options.maxTransactionRetries <= 0
      ? transactionFailures
      : transactionFailures.filter(
          (statement) =>
            deps.parseRepo.countFailedRuns(statement.id, "transactions") <
            options.maxTransactionRetries,
        );

  const retryableFailureIds = new Set(retryableFailures.map((item) => item.id));
  const uniqueTransactionCandidates = [
    ...metadataParsed,
    ...retryableFailures.filter((statement) => !metadataParsed.some((item) => item.id === statement.id)),
  ];

  const summary: ParseBankStatementsSummary = {
    discoveredCandidates: discovered.length,
    transactionCandidates: uniqueTransactionCandidates.length,
    transactionsParsed: 0,
    errorMetadata: 0,
    errorTransactions: 0,
    skippedRetries: transactionFailures.length - retryableFailureIds.size,
  };

  for (const statement of discovered) {
    await processDiscoveredStatement(deps, statement, summary);
  }

  for (const statement of uniqueTransactionCandidates) {
    await processTransactionsOnlyStatement(deps, statement, summary);
  }

  deps.logger.info("Bank statement parsing cycle complete", { ...summary });

  return summary;
}

async function processDiscoveredStatement(
  deps: ParseBankStatementsDeps,
  statement: BankStatement,
  summary: ParseBankStatementsSummary,
): Promise<void> {
  const parser = deps.parserRegistry.resolve(statement);
  if (!parser) {
    recordErrorRun(deps, {
      statement,
      stage: "metadata",
      parser: null,
      errorCode: ERROR_CODES.parserNotFound,
      errorMessage: "No parser resolved for statement",
      durationMs: 0,
    });
    deps.bankStatementRepo.markErrorMetadata(statement.id);
    summary.errorMetadata++;
    return;
  }

  const document = await deps.documentProvider.getStatementDocument(statement);
  if (!document) {
    recordErrorRun(deps, {
      statement,
      stage: "metadata",
      parser,
      errorCode: ERROR_CODES.documentUnavailable,
      errorMessage: "Statement document unavailable",
      durationMs: 0,
    });
    deps.bankStatementRepo.markErrorMetadata(statement.id);
    summary.errorMetadata++;
    return;
  }

  const metadataStart = Date.now();
  let parsedMetadata: ReturnType<BankStatementParser["parseMetadata"]>;

  try {
    parsedMetadata = parser.parseMetadata({ statement, document });
    deps.parseRepo.upsertMetadata({
      statementId: statement.id,
      userId: statement.userId,
      ...parsedMetadata,
      parserId: parser.id,
      parserVersion: parser.version,
    });
    deps.parseRepo.recordParseRun({
      statementId: statement.id,
      userId: statement.userId,
      stage: "metadata",
      outcome: "success",
      parserId: parser.id,
      parserVersion: parser.version,
      errorCode: null,
      errorMessage: null,
      durationMs: Date.now() - metadataStart,
    });
    deps.bankStatementRepo.markMetadataParsed(statement.id);
  } catch (error) {
    recordErrorRun(deps, {
      statement,
      stage: "metadata",
      parser,
      errorCode: ERROR_CODES.metadataParseFailed,
      errorMessage: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - metadataStart,
    });
    deps.bankStatementRepo.markErrorMetadata(statement.id);
    summary.errorMetadata++;
    return;
  }

  const transactionsStart = Date.now();

  try {
    const parsedTransactions = parser.parseTransactions({
      statement,
      document,
      metadata: parsedMetadata,
    });

    deps.parseRepo.replaceTransactions(
      statement.id,
      parsedTransactions.map((transaction) => ({
        userId: statement.userId,
        ...transaction,
      })),
    );

    deps.parseRepo.recordParseRun({
      statementId: statement.id,
      userId: statement.userId,
      stage: "transactions",
      outcome: "success",
      parserId: parser.id,
      parserVersion: parser.version,
      errorCode: null,
      errorMessage: null,
      durationMs: Date.now() - transactionsStart,
    });

    deps.bankStatementRepo.markTransactionsParsed(statement.id);
    summary.transactionsParsed++;
  } catch (error) {
    recordErrorRun(deps, {
      statement,
      stage: "transactions",
      parser,
      errorCode: ERROR_CODES.transactionParseFailed,
      errorMessage: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - transactionsStart,
    });
    deps.bankStatementRepo.markTransactionsError(statement.id);
    summary.errorTransactions++;
  }
}

async function processTransactionsOnlyStatement(
  deps: ParseBankStatementsDeps,
  statement: BankStatement,
  summary: ParseBankStatementsSummary,
): Promise<void> {
  const parser = deps.parserRegistry.resolve(statement);
  if (!parser) {
    recordErrorRun(deps, {
      statement,
      stage: "transactions",
      parser: null,
      errorCode: ERROR_CODES.parserNotFound,
      errorMessage: "No parser resolved for statement",
      durationMs: 0,
    });
    deps.bankStatementRepo.markTransactionsError(statement.id);
    summary.errorTransactions++;
    return;
  }

  const document = await deps.documentProvider.getStatementDocument(statement);
  if (!document) {
    recordErrorRun(deps, {
      statement,
      stage: "transactions",
      parser,
      errorCode: ERROR_CODES.documentUnavailable,
      errorMessage: "Statement document unavailable",
      durationMs: 0,
    });
    deps.bankStatementRepo.markTransactionsError(statement.id);
    summary.errorTransactions++;
    return;
  }

  const transactionsStart = Date.now();

  try {
    const parsedTransactions = parser.parseTransactions({ statement, document });

    deps.parseRepo.replaceTransactions(
      statement.id,
      parsedTransactions.map((transaction) => ({
        userId: statement.userId,
        ...transaction,
      })),
    );

    deps.parseRepo.recordParseRun({
      statementId: statement.id,
      userId: statement.userId,
      stage: "transactions",
      outcome: "success",
      parserId: parser.id,
      parserVersion: parser.version,
      errorCode: null,
      errorMessage: null,
      durationMs: Date.now() - transactionsStart,
    });

    deps.bankStatementRepo.markTransactionsParsed(statement.id);
    summary.transactionsParsed++;
  } catch (error) {
    recordErrorRun(deps, {
      statement,
      stage: "transactions",
      parser,
      errorCode: ERROR_CODES.transactionParseFailed,
      errorMessage: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - transactionsStart,
    });
    deps.bankStatementRepo.markTransactionsError(statement.id);
    summary.errorTransactions++;
  }
}

function recordErrorRun(
  deps: ParseBankStatementsDeps,
  params: {
    statement: BankStatement;
    stage: "metadata" | "transactions";
    parser: BankStatementParser | null;
    errorCode: string;
    errorMessage: string;
    durationMs: number;
  },
): void {
  deps.parseRepo.recordParseRun({
    statementId: params.statement.id,
    userId: params.statement.userId,
    stage: params.stage,
    outcome: "error",
    parserId: params.parser?.id ?? null,
    parserVersion: params.parser?.version ?? null,
    errorCode: params.errorCode,
    errorMessage: params.errorMessage,
    durationMs: params.durationMs,
  });

  deps.logger.warn("Bank statement parse stage failed", {
    statementId: params.statement.id,
    stage: params.stage,
    parserId: params.parser?.id ?? null,
    parserVersion: params.parser?.version ?? null,
    errorCode: params.errorCode,
    errorMessage: params.errorMessage,
  });
}
