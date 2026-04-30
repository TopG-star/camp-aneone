import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type {
  BankStatement,
  BankStatementIntakeStatus,
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

function createDeps(overrides: Partial<FinanceStatementsRouteDeps> = {}): FinanceStatementsRouteDeps {
  return {
    bankStatementRepo: createMockRepo(),
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
});
