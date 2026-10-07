import { describe, it, expect, vi } from "vitest";
import type {
  BankStatement,
  BankStatementParseRepository,
  BankStatementParsedTransaction,
  BankStatementRepository,
} from "@oneon/domain";
import {
  createFinanceStatementStatusTool,
  financeStatementStatusSchema,
} from "./finance-statement-status.js";
import {
  createSearchFinanceTransactionsTool,
  searchFinanceTransactionsSchema,
} from "./search-finance-transactions.js";
import {
  createTopFinanceTransactionsTool,
  topFinanceTransactionsSchema,
} from "./top-finance-transactions.js";
import {
  createSummarizeFinanceSpendTool,
  summarizeFinanceSpendSchema,
} from "./summarize-finance-spend.js";

function makeStatement(overrides: Partial<BankStatement> = {}): BankStatement {
  return {
    id: "stmt-001",
    userId: "user-001",
    source: "gmail",
    externalId: "ext-001",
    messageId: "msg-001",
    threadId: null,
    sender: "alerts@chase.com",
    senderDomain: "chase.com",
    subject: "Your statement is ready",
    receivedAt: "2026-04-20T10:00:00.000Z",
    status: "transactions_parsed",
    detectionRuleVersion: "1.0.0",
    createdAt: "2026-04-20T10:00:00.000Z",
    updatedAt: "2026-04-20T10:00:00.000Z",
    ...overrides,
  };
}

function makeTransaction(
  overrides: Partial<BankStatementParsedTransaction> = {},
): BankStatementParsedTransaction {
  return {
    id: "tx-001",
    statementId: "stmt-001",
    userId: "user-001",
    postedAt: "2026-04-20",
    description: "UBER TRIP",
    amountMinor: -1200,
    balanceMinor: null,
    dedupeKey: "dedupe-001",
    createdAt: "2026-04-20T10:00:00.000Z",
    ...overrides,
  };
}

function makeBankStatementRepo(
  overrides: Partial<BankStatementRepository> = {},
): BankStatementRepository {
  return {
    upsert: vi.fn(),
    findById: vi.fn().mockReturnValue(null),
    findBySourceAndExternalId: vi.fn().mockReturnValue(null),
    findByStatus: vi.fn().mockReturnValue([]),
    markMetadataParsed: vi.fn(),
    markErrorMetadata: vi.fn(),
    markTransactionsParsed: vi.fn(),
    markTransactionsError: vi.fn(),
    count: vi.fn().mockReturnValue(0),
    ...overrides,
  };
}

function makeParseRepo(
  overrides: Partial<
    Pick<BankStatementParseRepository, "findTransactions">
  > = {},
): Pick<BankStatementParseRepository, "findTransactions"> {
  return {
    findTransactions: vi.fn().mockReturnValue([]),
    ...overrides,
  };
}

describe("financeStatementStatusSchema", () => {
  it("applies defaults", () => {
    const result = financeStatementStatusSchema.parse({});
    expect(result.includeRecent).toBe(true);
    expect(result.limit).toBe(20);
    expect(result.userId).toBeUndefined();
  });
});

describe("finance_statement_status tool", () => {
  it("returns empty counts when no statements are available", async () => {
    const bankStatementRepo = makeBankStatementRepo();
    const tool = createFinanceStatementStatusTool({ bankStatementRepo });

    const result = await tool.execute(financeStatementStatusSchema.parse({}));

    expect(result.summary).toContain("No finance statements found yet");
    expect(result.data).toEqual({
      userId: null,
      counts: {
        discovered: 0,
        metadataParsed: 0,
        errorMetadata: 0,
        transactionsParsed: 0,
        errorTransactions: 0,
        total: 0,
      },
      recent: [],
    });
  });

  it("returns user-scoped counts and recent statements", async () => {
    const latest = makeStatement({
      id: "stmt-latest",
      status: "transactions_parsed",
      receivedAt: "2026-04-22T10:00:00.000Z",
    });
    const older = makeStatement({
      id: "stmt-older",
      status: "error_transactions",
      receivedAt: "2026-04-21T10:00:00.000Z",
    });

    const bankStatementRepo = makeBankStatementRepo({
      findByStatus: vi
        .fn()
        .mockReturnValueOnce([latest])
        .mockReturnValueOnce([])
        .mockReturnValueOnce([])
        .mockReturnValueOnce([older])
        .mockReturnValueOnce([])
        .mockReturnValueOnce([latest])
        .mockReturnValueOnce([])
        .mockReturnValueOnce([])
        .mockReturnValueOnce([older])
        .mockReturnValueOnce([]),
      count: vi.fn().mockImplementation((options?: { status?: string }) => {
        if (!options?.status) return 6;
        if (options.status === "discovered") return 1;
        if (options.status === "metadata_parsed") return 1;
        if (options.status === "error_metadata") return 1;
        if (options.status === "transactions_parsed") return 2;
        if (options.status === "error_transactions") return 1;
        return 0;
      }),
    });

    const tool = createFinanceStatementStatusTool({ bankStatementRepo });
    const result = await tool.execute(
      financeStatementStatusSchema.parse({ includeRecent: true, limit: 2 }),
    );

    expect((result.data as { userId: string }).userId).toBe("user-001");
    expect((result.data as { recent: BankStatement[] }).recent).toHaveLength(2);
    expect((result.data as { recent: BankStatement[] }).recent[0].id).toBe("stmt-latest");
    expect(result.summary).toContain("6 total");
  });
});

describe("searchFinanceTransactionsSchema", () => {
  it("applies defaults", () => {
    const result = searchFinanceTransactionsSchema.parse({});
    expect(result.limit).toBe(50);
    expect(result.q).toBeUndefined();
    expect(result.from).toBeUndefined();
    expect(result.to).toBeUndefined();
  });
});

describe("search_finance_transactions tool", () => {
  it("returns empty when no statement user can be resolved", async () => {
    const bankStatementRepo = makeBankStatementRepo();
    const bankStatementParseRepo = makeParseRepo();

    const tool = createSearchFinanceTransactionsTool({
      bankStatementRepo,
      bankStatementParseRepo,
    });

    const result = await tool.execute(searchFinanceTransactionsSchema.parse({ q: "uber" }));

    expect(result.data).toEqual([]);
    expect(result.summary).toContain("No finance statements found yet");
  });

  it("delegates to parse repo with resolved user and filters", async () => {
    const bankStatementRepo = makeBankStatementRepo({
      findByStatus: vi.fn().mockReturnValue([makeStatement()]),
    });
    const bankStatementParseRepo = makeParseRepo({
      findTransactions: vi.fn().mockReturnValue([makeTransaction()]),
    });

    const tool = createSearchFinanceTransactionsTool({
      bankStatementRepo,
      bankStatementParseRepo,
    });

    const result = await tool.execute(
      searchFinanceTransactionsSchema.parse({
        q: "uber",
        from: "2026-04-01",
        to: "2026-04-30",
        limit: 10,
      }),
    );

    expect(bankStatementParseRepo.findTransactions).toHaveBeenCalledWith({
      userId: "user-001",
      statementId: undefined,
      searchText: "uber",
      postedAtFrom: "2026-04-01",
      postedAtTo: "2026-04-30",
      limit: 10,
    });
    expect(result.summary).toContain("Found 1 transaction");
  });

  it("returns statement not found for invalid statementId", async () => {
    const bankStatementRepo = makeBankStatementRepo({
      findByStatus: vi.fn().mockReturnValue([makeStatement()]),
      findById: vi.fn().mockReturnValue(null),
    });
    const bankStatementParseRepo = makeParseRepo();

    const tool = createSearchFinanceTransactionsTool({
      bankStatementRepo,
      bankStatementParseRepo,
    });

    const result = await tool.execute(
      searchFinanceTransactionsSchema.parse({ statementId: "missing" }),
    );

    expect(result.data).toEqual([]);
    expect(result.summary).toContain("Statement not found");
  });
});

describe("topFinanceTransactionsSchema", () => {
  it("applies defaults", () => {
    const result = topFinanceTransactionsSchema.parse({});
    expect(result.limit).toBe(10);
    expect(result.direction).toBe("outflow");
  });
});

describe("top_finance_transactions tool", () => {
  it("returns top outflow transactions by magnitude", async () => {
    const bankStatementRepo = makeBankStatementRepo({
      findByStatus: vi.fn().mockReturnValue([makeStatement()]),
    });
    const bankStatementParseRepo = makeParseRepo({
      findTransactions: vi.fn().mockReturnValue([
        makeTransaction({ id: "tx-1", amountMinor: -1500 }),
        makeTransaction({ id: "tx-2", amountMinor: -5000 }),
        makeTransaction({ id: "tx-3", amountMinor: -2200 }),
        makeTransaction({ id: "tx-4", amountMinor: 9000 }),
      ]),
    });

    const tool = createTopFinanceTransactionsTool({
      bankStatementRepo,
      bankStatementParseRepo,
    });

    const result = await tool.execute(
      topFinanceTransactionsSchema.parse({ direction: "outflow", limit: 2 }),
    );

    const data = result.data as BankStatementParsedTransaction[];
    expect(data).toHaveLength(2);
    expect(data[0].id).toBe("tx-2");
    expect(data[1].id).toBe("tx-3");
  });

  it("returns empty data when no user can be resolved", async () => {
    const bankStatementRepo = makeBankStatementRepo();
    const bankStatementParseRepo = makeParseRepo();

    const tool = createTopFinanceTransactionsTool({
      bankStatementRepo,
      bankStatementParseRepo,
    });

    const result = await tool.execute(topFinanceTransactionsSchema.parse({}));

    expect(result.data).toEqual([]);
    expect(result.summary).toContain("No finance statements found yet");
  });
});

describe("summarizeFinanceSpendSchema", () => {
  it("applies defaults", () => {
    const result = summarizeFinanceSpendSchema.parse({});
    expect(result.limit).toBe(300);
  });
});

describe("summarize_finance_spend tool", () => {
  it("groups spending by category from transaction descriptions", async () => {
    const bankStatementRepo = makeBankStatementRepo({
      findByStatus: vi.fn().mockReturnValue([makeStatement()]),
    });
    const bankStatementParseRepo = makeParseRepo({
      findTransactions: vi.fn().mockReturnValue([
        makeTransaction({ id: "tx-1", description: "UBER TRIP", amountMinor: -1200 }),
        makeTransaction({ id: "tx-2", description: "WHOLEFOODS", amountMinor: -4500 }),
        makeTransaction({ id: "tx-3", description: "STARBUCKS", amountMinor: -700 }),
        makeTransaction({ id: "tx-4", description: "PAYROLL", amountMinor: 250000 }),
      ]),
    });

    const tool = createSummarizeFinanceSpendTool({
      bankStatementRepo,
      bankStatementParseRepo,
    });

    const result = await tool.execute(summarizeFinanceSpendSchema.parse({}));

    const categories = result.data as Array<{ category: string; amountMinor: number }>;
    expect(categories.length).toBeGreaterThan(0);
    expect(categories.some((item) => item.category === "groceries")).toBe(true);
    expect(categories.some((item) => item.category === "transport")).toBe(true);
    expect(result.summary).toContain("Top category");
  });

  it("returns empty summary when there are no outgoing transactions", async () => {
    const bankStatementRepo = makeBankStatementRepo({
      findByStatus: vi.fn().mockReturnValue([makeStatement()]),
    });
    const bankStatementParseRepo = makeParseRepo({
      findTransactions: vi.fn().mockReturnValue([
        makeTransaction({ amountMinor: 1200 }),
        makeTransaction({ amountMinor: 5000 }),
      ]),
    });

    const tool = createSummarizeFinanceSpendTool({
      bankStatementRepo,
      bankStatementParseRepo,
    });

    const result = await tool.execute(summarizeFinanceSpendSchema.parse({}));

    expect(result.data).toEqual([]);
    expect(result.summary).toContain("No outgoing spending found");
  });
});
