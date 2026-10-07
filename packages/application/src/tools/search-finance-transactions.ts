import { z } from "zod";
import type {
  BankStatementParseRepository,
  BankStatementParsedTransaction,
  BankStatementRepository,
} from "@oneon/domain";
import type { ToolDefinition, ToolResult } from "./tool-registry.js";
import { resolveFinanceUserId } from "./finance-tool-helpers.js";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const searchFinanceTransactionsSchema = z.object({
  q: z.string().trim().min(1).optional(),
  from: z
    .string()
    .regex(DATE_PATTERN, "from must be in YYYY-MM-DD format")
    .optional(),
  to: z
    .string()
    .regex(DATE_PATTERN, "to must be in YYYY-MM-DD format")
    .optional(),
  statementId: z.string().trim().min(1).optional(),
  limit: z.number().int().positive().max(500).optional().default(50),
  userId: z.string().trim().min(1).optional(),
});

export type SearchFinanceTransactionsInput = z.infer<
  typeof searchFinanceTransactionsSchema
>;

export interface SearchFinanceTransactionsDeps {
  bankStatementRepo: Pick<
    BankStatementRepository,
    "findByStatus" | "findById"
  >;
  bankStatementParseRepo: Pick<BankStatementParseRepository, "findTransactions">;
}

export function createSearchFinanceTransactionsTool(
  deps: SearchFinanceTransactionsDeps,
): ToolDefinition {
  const { bankStatementRepo, bankStatementParseRepo } = deps;

  return {
    name: "search_finance_transactions",
    version: "1.0.0",
    description:
      "Search parsed finance transactions by text, statement id, and date range.",
    inputSchema: searchFinanceTransactionsSchema,
    execute(validatedInput: unknown): ToolResult {
      const input = validatedInput as SearchFinanceTransactionsInput;
      const userId = resolveFinanceUserId(bankStatementRepo, input.userId);

      if (!userId) {
        return {
          data: [],
          summary: "No finance statements found yet.",
        };
      }

      if (input.statementId) {
        const statement = bankStatementRepo.findById(input.statementId);
        if (!statement || statement.userId !== userId) {
          return {
            data: [],
            summary: `Statement not found for id "${input.statementId}".`,
          };
        }
      }

      const transactions = bankStatementParseRepo.findTransactions({
        userId,
        statementId: input.statementId,
        searchText: input.q,
        postedAtFrom: input.from,
        postedAtTo: input.to,
        limit: input.limit,
      });

      return {
        data: transactions satisfies BankStatementParsedTransaction[],
        summary: summarizeSearchResult(transactions.length, input.q),
      };
    },
  };
}

function summarizeSearchResult(count: number, query?: string): string {
  if (query) {
    if (count === 0) {
      return `Found 0 transactions for "${query}".`;
    }
    return `Found ${count} transaction${count === 1 ? "" : "s"} for "${query}".`;
  }

  if (count === 0) {
    return "Found 0 transactions.";
  }

  return `Found ${count} transaction${count === 1 ? "" : "s"}.`;
}
