import { z } from "zod";
import type { BankStatement, BankStatementRepository } from "@oneon/domain";
import type { ToolDefinition, ToolResult } from "./tool-registry.js";
import {
  listRecentFinanceStatements,
  readFinanceStatusCounts,
  resolveFinanceUserId,
} from "./finance-tool-helpers.js";

export const financeStatementStatusSchema = z.object({
  includeRecent: z.boolean().optional().default(true),
  limit: z.number().int().positive().max(100).optional().default(20),
  userId: z.string().trim().min(1).optional(),
});

export type FinanceStatementStatusInput = z.infer<typeof financeStatementStatusSchema>;

export interface FinanceStatementStatusDeps {
  bankStatementRepo: Pick<
    BankStatementRepository,
    "findByStatus" | "count"
  >;
}

interface FinanceStatementStatusData {
  userId: string | null;
  counts: {
    discovered: number;
    metadataParsed: number;
    errorMetadata: number;
    transactionsParsed: number;
    errorTransactions: number;
    total: number;
  };
  recent: BankStatement[];
}

export function createFinanceStatementStatusTool(
  deps: FinanceStatementStatusDeps,
): ToolDefinition {
  const { bankStatementRepo } = deps;

  return {
    name: "finance_statement_status",
    version: "1.0.0",
    description:
      "Show finance statement processing status with total counts and recent statement items.",
    inputSchema: financeStatementStatusSchema,
    execute(validatedInput: unknown): ToolResult {
      const input = validatedInput as FinanceStatementStatusInput;
      const userId = resolveFinanceUserId(bankStatementRepo, input.userId);

      if (!userId) {
        const empty: FinanceStatementStatusData = {
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
        };

        return {
          data: empty,
          summary: "No finance statements found yet.",
        };
      }

      const counts = readFinanceStatusCounts(bankStatementRepo, userId);
      const recent = input.includeRecent
        ? listRecentFinanceStatements(bankStatementRepo, input.limit, userId)
        : [];

      const pendingCount = counts.discovered + counts.metadataParsed;
      const errorCount = counts.errorMetadata + counts.errorTransactions;

      return {
        data: {
          userId,
          counts,
          recent,
        } satisfies FinanceStatementStatusData,
        summary: `Finance statements: ${counts.total} total (${counts.transactionsParsed} parsed, ${pendingCount} pending, ${errorCount} errors).`,
      };
    },
  };
}
