import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BankStatement, Logger, Source } from "@oneon/domain";
import { parseBankStatements } from "../parse-bank-statements.js";

interface MockParser {
  id: string;
  version: number;
  parseMetadata: ReturnType<typeof vi.fn>;
  parseTransactions: ReturnType<typeof vi.fn>;
}

function makeStatement(id: string, status: BankStatement["status"]): BankStatement {
  const now = "2026-05-01T08:00:00.000Z";
  return {
    id,
    userId: "u1",
    source: "gmail" as Source,
    externalId: `ext-${id}`,
    messageId: `msg-${id}`,
    threadId: `thread-${id}`,
    sender: "alerts@chase.com",
    senderDomain: "chase.com",
    subject: "Your monthly statement is ready",
    receivedAt: now,
    status,
    detectionRuleVersion: "fin-001b-v1",
    createdAt: now,
    updatedAt: now,
  };
}

function mockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("parseBankStatements", () => {
  const statement = makeStatement("s1", "discovered");
  let logger: Logger;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = mockLogger();
  });

  it("parses discovered statement through metadata and transactions", async () => {
    const parser: MockParser = {
      id: "chase_pdf",
      version: 1,
      parseMetadata: vi.fn().mockReturnValue({
        accountLast4: "1234",
        statementDate: "2026-04-30",
        periodStart: "2026-04-01",
        periodEnd: "2026-04-30",
        currency: "USD",
        openingBalanceMinor: 120000,
        closingBalanceMinor: 105530,
      }),
      parseTransactions: vi.fn().mockReturnValue([
        {
          postedAt: "2026-04-20",
          description: "Coffee Shop",
          amountMinor: -450,
          balanceMinor: 109300,
          dedupeKey: "2026-04-20|coffee shop|-450",
        },
      ]),
    };

    const bankStatementRepo = {
      findByStatus: vi.fn((status: BankStatement["status"]) =>
        status === "discovered" ? [statement] : []
      ),
      markMetadataParsed: vi.fn(),
      markTransactionsParsed: vi.fn(),
      markErrorMetadata: vi.fn(),
      markTransactionsError: vi.fn(),
    };

    const parseRepo = {
      upsertMetadata: vi.fn(),
      replaceTransactions: vi.fn(),
      recordParseRun: vi.fn(),
      countFailedRuns: vi.fn().mockReturnValue(0),
    };

    const parserRegistry = {
      resolve: vi.fn().mockReturnValue(parser),
    };

    const documentProvider = {
      getStatementDocument: vi.fn().mockResolvedValue({
        mimeType: "application/pdf",
        content: new Uint8Array([1, 2, 3]),
      }),
    };

    const result = await parseBankStatements(
      {
        bankStatementRepo,
        parseRepo,
        parserRegistry,
        documentProvider,
        logger,
      },
      {
        userId: "u1",
        batchSize: 5,
        maxTransactionRetries: 2,
      },
    );

    expect(bankStatementRepo.markMetadataParsed).toHaveBeenCalledWith("s1");
    expect(bankStatementRepo.markTransactionsParsed).toHaveBeenCalledWith("s1");
    expect(parseRepo.upsertMetadata).toHaveBeenCalledTimes(1);
    expect(parseRepo.replaceTransactions).toHaveBeenCalledTimes(1);
    expect(result.transactionsParsed).toBe(1);
  });

  it("marks statement as error_metadata when parser cannot be resolved", async () => {
    const bankStatementRepo = {
      findByStatus: vi.fn((status: BankStatement["status"]) =>
        status === "discovered" ? [statement] : []
      ),
      markMetadataParsed: vi.fn(),
      markTransactionsParsed: vi.fn(),
      markErrorMetadata: vi.fn(),
      markTransactionsError: vi.fn(),
    };

    const parseRepo = {
      upsertMetadata: vi.fn(),
      replaceTransactions: vi.fn(),
      recordParseRun: vi.fn(),
      countFailedRuns: vi.fn().mockReturnValue(0),
    };

    const result = await parseBankStatements(
      {
        bankStatementRepo,
        parseRepo,
        parserRegistry: { resolve: vi.fn().mockReturnValue(null) },
        documentProvider: { getStatementDocument: vi.fn() },
        logger,
      },
      {
        userId: "u1",
        batchSize: 5,
        maxTransactionRetries: 2,
      },
    );

    expect(bankStatementRepo.markErrorMetadata).toHaveBeenCalledWith("s1");
    expect(bankStatementRepo.markMetadataParsed).not.toHaveBeenCalled();
    expect(result.errorMetadata).toBe(1);
  });

  it("marks metadata_parsed statement as error_transactions when transaction parsing fails", async () => {
    const parser: MockParser = {
      id: "chase_pdf",
      version: 1,
      parseMetadata: vi.fn(),
      parseTransactions: vi.fn().mockImplementation(() => {
        throw new Error("failed to parse transactions");
      }),
    };

    const metadataParsedStatement = makeStatement("s2", "metadata_parsed");

    const bankStatementRepo = {
      findByStatus: vi.fn((status: BankStatement["status"]) =>
        status === "metadata_parsed" ? [metadataParsedStatement] : []
      ),
      markMetadataParsed: vi.fn(),
      markTransactionsParsed: vi.fn(),
      markErrorMetadata: vi.fn(),
      markTransactionsError: vi.fn(),
    };

    const parseRepo = {
      upsertMetadata: vi.fn(),
      replaceTransactions: vi.fn(),
      recordParseRun: vi.fn(),
      countFailedRuns: vi.fn().mockReturnValue(0),
    };

    await parseBankStatements(
      {
        bankStatementRepo,
        parseRepo,
        parserRegistry: { resolve: vi.fn().mockReturnValue(parser) },
        documentProvider: {
          getStatementDocument: vi.fn().mockResolvedValue({
            mimeType: "application/pdf",
            content: new Uint8Array([1, 2, 3]),
          }),
        },
        logger,
      },
      {
        userId: "u1",
        batchSize: 5,
        maxTransactionRetries: 2,
      },
    );

    expect(bankStatementRepo.markTransactionsError).toHaveBeenCalledWith("s2");
    expect(bankStatementRepo.markTransactionsParsed).not.toHaveBeenCalled();
  });
});
