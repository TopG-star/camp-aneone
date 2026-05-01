import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type {
  BankStatement,
  BankStatementIntakeStatus,
  BankStatementParseRepository,
  BankStatementParseRun,
  BankStatementParsedMetadata,
  BankStatementParsedTransaction,
  BankStatementRepository,
  Source,
} from "@oneon/domain";
import {
  createFinanceStatementsRouter,
  type FinanceStatementsRouteDeps,
} from "./finance-statements.route.js";

function makeStatement(
  id: string,
  status: BankStatementIntakeStatus,
  receivedAt: string,
): BankStatement {
  return {
    id,
    userId: "u1",
    source: "gmail" as Source,
    externalId: id,
    messageId: id,
    threadId: "thread-1",
    sender: "alerts@bank.com",
    senderDomain: "bank.com",
    subject: `Statement ${id}`,
    receivedAt,
    status,
    detectionRuleVersion: "fin-001a-v1",
    createdAt: receivedAt,
    updatedAt: receivedAt,
  };
}

function createMockRepo(): BankStatementRepository {
  const items: BankStatement[] = [
    makeStatement("a", "discovered", "2026-04-29T10:00:00.000Z"),
    makeStatement("b", "metadata_parsed", "2026-04-29T11:00:00.000Z"),
    makeStatement("c", "error_metadata", "2026-04-29T09:00:00.000Z"),
  ];

  return {
    upsert: vi.fn(),
    findById: vi.fn((id: string) => items.find((it) => it.id === id) ?? null),
    findBySourceAndExternalId: vi.fn(),
    findByStatus: vi.fn((status: BankStatementIntakeStatus, limit: number, userId?: string) =>
      items
        .filter((it) => it.status === status && (!userId || it.userId === userId))
        .slice(0, limit)
    ),
    markMetadataParsed: vi.fn(),
    markErrorMetadata: vi.fn(),
    markTransactionsParsed: vi.fn(),
    markTransactionsError: vi.fn(),
    count: vi.fn((options?: { status?: BankStatementIntakeStatus; userId?: string }) =>
      items.filter(
        (it) =>
          (!options?.status || it.status === options.status) &&
          (!options?.userId || it.userId === options.userId)
      ).length
    ),
  };
}

function createMockParseRepo(): BankStatementParseRepository {
  const metadataRows: Record<string, BankStatementParsedMetadata> = {
    b: {
      id: "meta-b",
      statementId: "b",
      userId: "u1",
      accountLast4: "1234",
      statementDate: "2026-04-30",
      periodStart: "2026-04-01",
      periodEnd: "2026-04-30",
      currency: "USD",
      openingBalanceMinor: 100000,
      closingBalanceMinor: 92500,
      parserId: "chase_pdf",
      parserVersion: 1,
      createdAt: "2026-04-29T11:05:00.000Z",
      updatedAt: "2026-04-29T11:05:00.000Z",
    },
  };

  const transactions: BankStatementParsedTransaction[] = [
    {
      id: "tx-1",
      statementId: "b",
      userId: "u1",
      postedAt: "2026-04-20",
      description: "Coffee Shop",
      amountMinor: -450,
      balanceMinor: 99100,
      dedupeKey: "2026-04-20|coffee shop|-450",
      createdAt: "2026-04-29T11:06:00.000Z",
    },
    {
      id: "tx-2",
      statementId: "b",
      userId: "u1",
      postedAt: "2026-04-21",
      description: "Payroll",
      amountMinor: 200000,
      balanceMinor: 299100,
      dedupeKey: "2026-04-21|payroll|200000",
      createdAt: "2026-04-29T11:06:05.000Z",
    },
  ];

  const parseRuns: BankStatementParseRun[] = [
    {
      id: "run-2",
      statementId: "b",
      userId: "u1",
      stage: "transactions",
      outcome: "success",
      parserId: "chase_pdf",
      parserVersion: 1,
      errorCode: null,
      errorMessage: null,
      durationMs: 24,
      createdAt: "2026-04-29T11:07:00.000Z",
    },
    {
      id: "run-1",
      statementId: "b",
      userId: "u1",
      stage: "metadata",
      outcome: "success",
      parserId: "chase_pdf",
      parserVersion: 1,
      errorCode: null,
      errorMessage: null,
      durationMs: 19,
      createdAt: "2026-04-29T11:06:30.000Z",
    },
  ];

  return {
    upsertMetadata: vi.fn(),
    replaceTransactions: vi.fn(),
    recordParseRun: vi.fn(),
    countFailedRuns: vi.fn().mockReturnValue(0),
    findMetadataByStatementId: vi.fn((statementId: string, userId: string) => {
      const row = metadataRows[statementId];
      if (!row || row.userId !== userId) {
        return null;
      }
      return row;
    }),
    findTransactions: vi.fn((options) => {
      return transactions
        .filter((tx) => tx.userId === options.userId)
        .filter((tx) => !options.statementId || tx.statementId === options.statementId)
        .filter((tx) => !options.searchText || tx.description.toLowerCase().includes(options.searchText.toLowerCase()))
        .filter((tx) => !options.postedAtFrom || tx.postedAt >= options.postedAtFrom)
        .filter((tx) => !options.postedAtTo || tx.postedAt <= options.postedAtTo)
        .slice(0, options.limit);
    }),
    findParseRuns: vi.fn((options) => {
      return parseRuns
        .filter((run) => run.statementId === options.statementId && run.userId === options.userId)
        .slice(0, options.limit);
    }),
  };
}

function createDeps(overrides: Partial<FinanceStatementsRouteDeps> = {}): FinanceStatementsRouteDeps {
  return {
    bankStatementRepo: createMockRepo(),
    bankStatementParseRepo: createMockParseRepo(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    ...overrides,
  };
}

function createApp(deps: FinanceStatementsRouteDeps, userId = "u1") {
  const app = express();
  app.use((req, _res, next) => {
    req.userId = userId;
    next();
  });
  app.use("/api/finance/statements", createFinanceStatementsRouter(deps));
  return app;
}

describe("Finance Statements Route", () => {
  let deps: FinanceStatementsRouteDeps;
  let app: express.Express;

  beforeEach(() => {
    deps = createDeps();
    app = createApp(deps);
  });

  it("returns counts and merged items by default", async () => {
    const res = await request(app).get("/api/finance/statements");

    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({
      discovered: 1,
      metadataParsed: 1,
      errorMetadata: 1,
      transactionsParsed: 0,
      errorTransactions: 0,
      total: 3,
    });
    expect(res.body.items).toHaveLength(3);
    expect(res.body.items[0].id).toBe("b");
  });

  it("filters by status when provided", async () => {
    const res = await request(app)
      .get("/api/finance/statements")
      .query({ status: "discovered", limit: "10" });

    expect(res.status).toBe(200);
    expect(res.body.filter).toEqual({ status: "discovered", limit: 10 });
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].status).toBe("discovered");
    expect(deps.bankStatementRepo.findByStatus).toHaveBeenCalledWith(
      "discovered",
      10,
      "u1",
    );
  });

  it("returns 400 for invalid status", async () => {
    const res = await request(app)
      .get("/api/finance/statements")
      .query({ status: "invalid_status" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("status");
  });

  it("returns 400 for invalid limit", async () => {
    const res = await request(app)
      .get("/api/finance/statements")
      .query({ limit: "0" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("limit");
  });

  it("returns 500 when repository throws", async () => {
    const failingDeps = createDeps({
      bankStatementRepo: {
        ...createMockRepo(),
        count: vi.fn(() => {
          throw new Error("DB down");
        }),
      },
    });
    const failingApp = createApp(failingDeps);

    const res = await request(failingApp).get("/api/finance/statements");

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Internal server error");
  });

  it("returns statement detail with metadata, transactions, and parse runs", async () => {
    const res = await request(app).get("/api/finance/statements/b");

    expect(res.status).toBe(200);
    expect(res.body.statement.id).toBe("b");
    expect(res.body.metadata.accountLast4).toBe("1234");
    expect(res.body.transactions).toHaveLength(2);
    expect(res.body.parseRuns).toHaveLength(2);
    expect(deps.bankStatementParseRepo.findMetadataByStatementId).toHaveBeenCalledWith("b", "u1");
    expect(deps.bankStatementParseRepo.findTransactions).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        statementId: "b",
      }),
    );
    expect(deps.bankStatementParseRepo.findParseRuns).toHaveBeenCalledWith({
      statementId: "b",
      userId: "u1",
      limit: 20,
    });
  });

  it("returns 404 when statement does not exist", async () => {
    const res = await request(app).get("/api/finance/statements/missing");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Statement not found");
  });

  it("returns transaction query results with filters", async () => {
    const res = await request(app)
      .get("/api/finance/statements/transactions")
      .query({ q: "coffee", from: "2026-04-01", to: "2026-04-30", limit: "5" });

    expect(res.status).toBe(200);
    expect(res.body.filter).toEqual({
      q: "coffee",
      from: "2026-04-01",
      to: "2026-04-30",
      statementId: null,
      limit: 5,
    });
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].description).toBe("Coffee Shop");
    expect(deps.bankStatementParseRepo.findTransactions).toHaveBeenCalledWith({
      userId: "u1",
      statementId: undefined,
      searchText: "coffee",
      postedAtFrom: "2026-04-01",
      postedAtTo: "2026-04-30",
      limit: 5,
    });
  });

  it("returns 400 for invalid transaction date filter", async () => {
    const res = await request(app)
      .get("/api/finance/statements/transactions")
      .query({ from: "2026/04/01" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("from");
  });
});
