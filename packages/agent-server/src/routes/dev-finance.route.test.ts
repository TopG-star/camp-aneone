import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type {
  BankStatement,
  BankStatementParseRepository,
  BankStatementParseRun,
  BankStatementParsedMetadata,
  BankStatementParsedTransaction,
  BankStatementParser,
  BankStatementParserRegistry,
  BankStatementRepository,
  Logger,
  User,
  UserRepository,
} from "@oneon/domain";
import {
  createDevFinanceRouter,
  type DevFinanceRouteDeps,
} from "./dev-finance.route.js";

function createMockUserRepo(): UserRepository {
  const users = new Map<string, User>();

  return {
    findById: vi.fn((id: string) => users.get(id) ?? null),
    findByEmail: vi.fn((email: string) => {
      const normalized = email.trim().toLowerCase();
      return Array.from(users.values()).find((user) => user.email === normalized) ?? null;
    }),
    upsert: vi.fn((input: { id: string; email: string }) => {
      const now = new Date().toISOString();
      const user: User = {
        id: input.id,
        email: input.email.trim().toLowerCase(),
        createdAt: now,
      };
      users.set(user.id, user);
      return user;
    }),
    list: vi.fn(() => Array.from(users.values())),
    delete: vi.fn((id: string) => {
      users.delete(id);
    }),
  };
}

function createMockBankStatementRepo(): BankStatementRepository {
  const statements = new Map<string, BankStatement>();

  return {
    upsert: vi.fn((input) => {
      const now = new Date().toISOString();
      const existing = Array.from(statements.values()).find(
        (statement) =>
          statement.userId === input.userId &&
          statement.source === input.source &&
          statement.externalId === input.externalId,
      );

      if (existing) {
        const updated: BankStatement = {
          ...existing,
          ...input,
          updatedAt: now,
        };
        statements.set(updated.id, updated);
        return updated;
      }

      const created: BankStatement = {
        id: `statement-${statements.size + 1}`,
        ...input,
        createdAt: now,
        updatedAt: now,
      };
      statements.set(created.id, created);
      return created;
    }),
    findById: vi.fn((id: string) => statements.get(id) ?? null),
    findBySourceAndExternalId: vi.fn((source, externalId, userId) => {
      return (
        Array.from(statements.values()).find(
          (statement) =>
            statement.source === source &&
            statement.externalId === externalId &&
            (!userId || statement.userId === userId),
        ) ?? null
      );
    }),
    findByStatus: vi.fn((status, limit, userId) => {
      return Array.from(statements.values())
        .filter((statement) => statement.status === status)
        .filter((statement) => !userId || statement.userId === userId)
        .slice(0, limit);
    }),
    markMetadataParsed: vi.fn((id: string) => {
      const statement = statements.get(id);
      if (!statement) return;
      statements.set(id, {
        ...statement,
        status: "metadata_parsed",
        updatedAt: new Date().toISOString(),
      });
    }),
    markErrorMetadata: vi.fn((id: string) => {
      const statement = statements.get(id);
      if (!statement) return;
      statements.set(id, {
        ...statement,
        status: "error_metadata",
        updatedAt: new Date().toISOString(),
      });
    }),
    markTransactionsParsed: vi.fn((id: string) => {
      const statement = statements.get(id);
      if (!statement) return;
      statements.set(id, {
        ...statement,
        status: "transactions_parsed",
        updatedAt: new Date().toISOString(),
      });
    }),
    markTransactionsError: vi.fn((id: string) => {
      const statement = statements.get(id);
      if (!statement) return;
      statements.set(id, {
        ...statement,
        status: "error_transactions",
        updatedAt: new Date().toISOString(),
      });
    }),
    count: vi.fn((options) => {
      return Array.from(statements.values())
        .filter((statement) => !options?.status || statement.status === options.status)
        .filter((statement) => !options?.userId || statement.userId === options.userId)
        .length;
    }),
  };
}

function createMockParseRepo(): BankStatementParseRepository {
  const metadataRows = new Map<string, BankStatementParsedMetadata>();
  const transactions: BankStatementParsedTransaction[] = [];
  const parseRuns: BankStatementParseRun[] = [];

  return {
    upsertMetadata: vi.fn((metadata) => {
      const now = new Date().toISOString();
      const existing = metadataRows.get(metadata.statementId);
      const row: BankStatementParsedMetadata = {
        id: existing?.id ?? `metadata-${metadataRows.size + 1}`,
        ...metadata,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      metadataRows.set(metadata.statementId, row);
      return row;
    }),
    replaceTransactions: vi.fn((statementId: string, nextTransactions) => {
      for (let i = transactions.length - 1; i >= 0; i -= 1) {
        if (transactions[i].statementId === statementId) {
          transactions.splice(i, 1);
        }
      }

      const createdAt = new Date().toISOString();
      const rows = nextTransactions.map((transaction: Omit<BankStatementParsedTransaction, "id" | "statementId" | "createdAt">, index: number) => {
        const row: BankStatementParsedTransaction = {
          id: `tx-${statementId}-${index + 1}`,
          statementId,
          ...transaction,
          createdAt,
        };
        transactions.push(row);
        return row;
      });

      return rows;
    }),
    recordParseRun: vi.fn((run) => {
      const row: BankStatementParseRun = {
        id: `run-${parseRuns.length + 1}`,
        ...run,
        createdAt: new Date().toISOString(),
      };
      parseRuns.push(row);
      return row;
    }),
    countFailedRuns: vi.fn((statementId: string, stage: "metadata" | "transactions") => {
      return parseRuns.filter(
        (run) =>
          run.statementId === statementId &&
          run.stage === stage &&
          run.outcome === "error",
      ).length;
    }),
    findMetadataByStatementId: vi.fn((statementId: string, userId: string) => {
      const row = metadataRows.get(statementId);
      if (!row || row.userId !== userId) {
        return null;
      }
      return row;
    }),
    findTransactions: vi.fn((options) => {
      return transactions
        .filter((transaction) => transaction.userId === options.userId)
        .filter((transaction) => !options.statementId || transaction.statementId === options.statementId)
        .filter((transaction) => !options.searchText || transaction.description.toLowerCase().includes(options.searchText.toLowerCase()))
        .filter((transaction) => !options.postedAtFrom || transaction.postedAt >= options.postedAtFrom)
        .filter((transaction) => !options.postedAtTo || transaction.postedAt <= options.postedAtTo)
        .slice(0, options.limit);
    }),
    findParseRuns: vi.fn((options) => {
      return parseRuns
        .filter((run) => run.statementId === options.statementId && run.userId === options.userId)
        .slice(0, options.limit);
    }),
  };
}

function createMockParserRegistry(): BankStatementParserRegistry {
  const parser: BankStatementParser = {
    id: "chase_pdf",
    version: 1,
    parseMetadata: vi.fn(() => ({
      accountLast4: "1234",
      statementDate: "2026-04-30",
      periodStart: "2026-04-01",
      periodEnd: "2026-04-30",
      currency: "USD",
      openingBalanceMinor: 120000,
      closingBalanceMinor: 105530,
      parserId: "chase_pdf",
      parserVersion: 1,
    })),
    parseTransactions: vi.fn(() => ([
      {
        postedAt: "2026-04-20",
        description: "Coffee Shop",
        amountMinor: -450,
        balanceMinor: 109300,
        dedupeKey: "2026-04-20|coffee shop|-450",
      },
    ])),
  };

  return {
    resolve: vi.fn((statement: BankStatement) => {
      if (statement.senderDomain !== "chase.com") {
        return null;
      }
      return parser;
    }),
  };
}

function createDeps(overrides: Partial<DevFinanceRouteDeps> = {}): DevFinanceRouteDeps {
  return {
    userRepo: createMockUserRepo(),
    bankStatementRepo: createMockBankStatementRepo(),
    bankStatementParseRepo: createMockParseRepo(),
    bankStatementParserRegistry: createMockParserRegistry(),
    allowedEmails: ["allowed@test.com"],
    maxTransactionRetries: 3,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } satisfies Logger,
    ...overrides,
  };
}

function createApp(deps: DevFinanceRouteDeps) {
  const app = express();
  app.use(express.json());
  app.use("/api/dev/finance", createDevFinanceRouter(deps));
  return app;
}

describe("Dev Finance Route", () => {
  it("creates user, ingests statement, and parses metadata/transactions", async () => {
    const deps = createDeps();
    const app = createApp(deps);

    const res = await request(app)
      .post("/api/dev/finance/ingest-statement")
      .send({
        userEmail: "allowed@test.com",
      });

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe("allowed@test.com");
    expect(res.body.statement.status).toBe("transactions_parsed");
    expect(res.body.metadata.accountLast4).toBe("1234");
    expect(res.body.transactions).toHaveLength(1);
    expect(res.body.parseRuns).toHaveLength(2);
    expect(res.body.parseSummary.transactionsParsed).toBe(1);
  });

  it("rejects user email not on allowed list", async () => {
    const deps = createDeps();
    const app = createApp(deps);

    const res = await request(app)
      .post("/api/dev/finance/ingest-statement")
      .send({
        userEmail: "blocked@test.com",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("allowed list");
  });

  it("returns 400 when statementText is provided but blank", async () => {
    const deps = createDeps();
    const app = createApp(deps);

    const res = await request(app)
      .post("/api/dev/finance/ingest-statement")
      .send({
        userEmail: "allowed@test.com",
        statementText: "   ",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("statementText");
  });
});
