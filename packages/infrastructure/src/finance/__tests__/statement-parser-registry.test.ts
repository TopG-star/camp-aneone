import { describe, expect, it } from "vitest";
import type { BankStatement, BankStatementParser } from "@oneon/domain";

import {
  StaticBankStatementParserRegistry,
  type BankStatementParserRegistration,
} from "../statement-parser-registry.js";

const mockParser: BankStatementParser = {
  id: "chase_pdf",
  version: 1,
  parseMetadata: () => {
    throw new Error("not used");
  },
  parseTransactions: () => {
    throw new Error("not used");
  },
};

function makeStatement(senderDomain: string): BankStatement {
  return {
    id: "s1",
    userId: "u1",
    source: "gmail",
    externalId: "ext-s1",
    messageId: "msg-s1",
    threadId: "thread-s1",
    sender: `alerts@${senderDomain}`,
    senderDomain,
    subject: "Monthly statement",
    receivedAt: "2026-05-01T09:00:00.000Z",
    status: "discovered",
    detectionRuleVersion: "fin-001c-v1",
    createdAt: "2026-05-01T09:00:00.000Z",
    updatedAt: "2026-05-01T09:00:00.000Z",
  };
}

describe("StaticBankStatementParserRegistry", () => {
  it("resolves parser by sender domain", () => {
    const registrations: BankStatementParserRegistration[] = [
      {
        senderDomains: ["chase.com", "alert.chase.com"],
        parser: mockParser,
      },
    ];

    const registry = new StaticBankStatementParserRegistry(registrations);

    expect(registry.resolve(makeStatement("chase.com"))).toBe(mockParser);
    expect(registry.resolve(makeStatement("alert.chase.com"))).toBe(mockParser);
  });

  it("matches sender domain case-insensitively", () => {
    const registry = new StaticBankStatementParserRegistry([
      {
        senderDomains: ["CHASE.COM"],
        parser: mockParser,
      },
    ]);

    expect(registry.resolve(makeStatement("chase.com"))).toBe(mockParser);
  });

  it("returns null when no parser matches", () => {
    const registry = new StaticBankStatementParserRegistry([
      {
        senderDomains: ["chase.com"],
        parser: mockParser,
      },
    ]);

    expect(registry.resolve(makeStatement("citi.com"))).toBeNull();
  });
});
