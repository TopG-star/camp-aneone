import { describe, expect, it } from "vitest";

import { ChaseBankStatementParser } from "../chase-bank-statement.parser.js";

const parser = new ChaseBankStatementParser();
const encoder = new TextEncoder();

const statement = {
  id: "s1",
  userId: "u1",
  source: "gmail" as const,
  externalId: "ext-s1",
  messageId: "msg-s1",
  threadId: "thread-s1",
  sender: "alerts@chase.com",
  senderDomain: "chase.com",
  subject: "Your monthly statement",
  receivedAt: "2026-05-01T09:00:00.000Z",
  status: "discovered" as const,
  detectionRuleVersion: "fin-001c-v1",
  createdAt: "2026-05-01T09:00:00.000Z",
  updatedAt: "2026-05-01T09:00:00.000Z",
};

describe("ChaseBankStatementParser", () => {
  it("parses metadata from canonical statement text", () => {
    const document = {
      mimeType: "text/plain",
      content: encoder.encode(`
        Account ending in 1234
        Statement Date: 04/30/2026
        Statement Period: 04/01/2026 - 04/30/2026
        Opening Balance: $1,000.00
        Closing Balance: $995.50
      `),
      fileName: "statement.txt",
    };

    const metadata = parser.parseMetadata({ statement, document });

    expect(metadata).toEqual({
      accountLast4: "1234",
      statementDate: "2026-04-30",
      periodStart: "2026-04-01",
      periodEnd: "2026-04-30",
      currency: "USD",
      openingBalanceMinor: 100000,
      closingBalanceMinor: 99550,
      parserId: "chase_pdf",
      parserVersion: 1,
    });
  });

  it("parses transactions from pipe-separated rows", () => {
    const document = {
      mimeType: "text/plain",
      content: encoder.encode(`
        Account ending in 1234
        Statement Date: 04/30/2026
        Statement Period: 04/01/2026 - 04/30/2026
        Opening Balance: $1,000.00
        Closing Balance: $995.50

        04/02/2026 | Coffee Shop | -4.50 | 995.50
        04/10/2026 | Payroll | 2000.00 | 2995.50
      `),
      fileName: "statement.txt",
    };

    const transactions = parser.parseTransactions({ statement, document });

    expect(transactions).toEqual([
      {
        postedAt: "2026-04-02",
        description: "Coffee Shop",
        amountMinor: -450,
        balanceMinor: 99550,
        dedupeKey: "2026-04-02|coffee shop|-450",
      },
      {
        postedAt: "2026-04-10",
        description: "Payroll",
        amountMinor: 200000,
        balanceMinor: 299550,
        dedupeKey: "2026-04-10|payroll|200000",
      },
    ]);
  });

  it("throws when metadata cannot be extracted", () => {
    const document = {
      mimeType: "text/plain",
      content: encoder.encode("Statement missing all required fields"),
      fileName: "statement.txt",
    };

    expect(() => parser.parseMetadata({ statement, document })).toThrow(
      "CHASE_METADATA_PARSE_FAILED",
    );
  });
});
