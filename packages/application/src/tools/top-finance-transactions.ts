import { z } from "zod";
import type {
  BankStatementParseRepository,
  BankStatementParsedTransaction,
  BankStatementRepository,
} from "@oneon/domain";
import type { ToolDefinition, ToolResult } from "./tool-registry.js";
import { resolveFinanceUserId } from "./finance-tool-helpers.js";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SAMPLE_FACTOR = 20;
const MIN_SAMPLE_LIMIT = 200;
const MAX_SAMPLE_LIMIT = 1000;

export const topFinanceTransactionsSchema = z.object({
  direction: z
    .enum(["outflow", "inflow", "absolute"])
    .optional()
    .default("outflow"),
  limit: z.number().int().positive().max(100).optional().default(10),
  from: z
    .string()
    .regex(DATE_PATTERN, "from must be in YYYY-MM-DD format")
    .optional(),
  to: z
    .string()
    .regex(DATE_PATTERN, "to must be in YYYY-MM-DD format")
    .optional(),
  userId: z.string().trim().min(1).optional(),
});

export type TopFinanceTransactionsInput = z.infer<typeof topFinanceTransactionsSchema>;

export interface TopFinanceTransactionsDeps {
  bankStatementRepo: Pick<BankStatementRepository, "findByStatus">;
  bankStatementParseRepo: Pick<BankStatementParseRepository, "findTransactions">;
}

export function createTopFinanceTransactionsTool(
  deps: TopFinanceTransactionsDeps,
): ToolDefinition {
  const { bankStatementRepo, bankStatementParseRepo } = deps;

  return {
    name: "top_finance_transactions",
    version: "1.0.0",
    description:
      "List top finance transactions by inflow, outflow, or absolute amount.",
    inputSchema: topFinanceTransactionsSchema,
    execute(validatedInput: unknown): ToolResult {
      const input = validatedInput as TopFinanceTransactionsInput;
      const userId = resolveFinanceUserId(bankStatementRepo, input.userId);

      if (!userId) {
        return {
          data: [],
          summary: "No finance statements found yet.",
        };
      }

      const sampleLimit = Math.min(
        MAX_SAMPLE_LIMIT,
        Math.max(MIN_SAMPLE_LIMIT, input.limit * SAMPLE_FACTOR),
      );

      const source = bankStatementParseRepo.findTransactions({
        userId,
        postedAtFrom: input.from,
        postedAtTo: input.to,
        limit: sampleLimit,
      });

      const ranked = rankTransactions(source, input.direction).slice(0, input.limit);

      if (ranked.length === 0) {
        return {
          data: [],
          summary: `No ${input.direction} transactions found.`,
        };
      }

      return {
        data: ranked,
        summary: `Found top ${ranked.length} ${input.direction} transaction${ranked.length === 1 ? "" : "s"}.`,
      };
    },
  };
}

function rankTransactions(
  transactions: BankStatementParsedTransaction[],
  direction: "outflow" | "inflow" | "absolute",
): BankStatementParsedTransaction[] {
  if (direction === "outflow") {
    return transactions
      .filter((tx) => tx.amountMinor < 0)
      .sort((a, b) => a.amountMinor - b.amountMinor);
  }

  if (direction === "inflow") {
    return transactions
      .filter((tx) => tx.amountMinor > 0)
      .sort((a, b) => b.amountMinor - a.amountMinor);
  }

  return [...transactions].sort(
    (a, b) => Math.abs(b.amountMinor) - Math.abs(a.amountMinor),
  );
}
