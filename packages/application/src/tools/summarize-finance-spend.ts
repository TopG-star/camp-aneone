import { z } from "zod";
import type {
  BankStatementParseRepository,
  BankStatementRepository,
} from "@oneon/domain";
import type { ToolDefinition, ToolResult } from "./tool-registry.js";
import { formatUsdMinor, resolveFinanceUserId } from "./finance-tool-helpers.js";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const summarizeFinanceSpendSchema = z.object({
  from: z
    .string()
    .regex(DATE_PATTERN, "from must be in YYYY-MM-DD format")
    .optional(),
  to: z
    .string()
    .regex(DATE_PATTERN, "to must be in YYYY-MM-DD format")
    .optional(),
  limit: z.number().int().positive().max(1000).optional().default(300),
  userId: z.string().trim().min(1).optional(),
});

export type SummarizeFinanceSpendInput = z.infer<typeof summarizeFinanceSpendSchema>;

export interface SpendCategoryRow {
  category: string;
  amountMinor: number;
  transactionCount: number;
}

export interface SummarizeFinanceSpendDeps {
  bankStatementRepo: Pick<BankStatementRepository, "findByStatus">;
  bankStatementParseRepo: Pick<BankStatementParseRepository, "findTransactions">;
}

export function createSummarizeFinanceSpendTool(
  deps: SummarizeFinanceSpendDeps,
): ToolDefinition {
  const { bankStatementRepo, bankStatementParseRepo } = deps;

  return {
    name: "summarize_finance_spend",
    version: "1.0.0",
    description:
      "Summarize outgoing spend by inferred category based on transaction descriptions.",
    inputSchema: summarizeFinanceSpendSchema,
    execute(validatedInput: unknown): ToolResult {
      const input = validatedInput as SummarizeFinanceSpendInput;
      const userId = resolveFinanceUserId(bankStatementRepo, input.userId);

      if (!userId) {
        return {
          data: [],
          summary: "No finance statements found yet.",
        };
      }

      const transactions = bankStatementParseRepo.findTransactions({
        userId,
        postedAtFrom: input.from,
        postedAtTo: input.to,
        limit: input.limit,
      });

      const outgoing = transactions.filter((tx) => tx.amountMinor < 0);
      if (outgoing.length === 0) {
        return {
          data: [],
          summary: "No outgoing spending found in the selected window.",
        };
      }

      const byCategory = new Map<string, SpendCategoryRow>();

      for (const tx of outgoing) {
        const category = inferCategory(tx.description);
        const current = byCategory.get(category) ?? {
          category,
          amountMinor: 0,
          transactionCount: 0,
        };

        current.amountMinor += Math.abs(tx.amountMinor);
        current.transactionCount += 1;

        byCategory.set(category, current);
      }

      const rows = Array.from(byCategory.values()).sort(
        (a, b) => b.amountMinor - a.amountMinor,
      );

      const totalSpendMinor = rows.reduce((sum, row) => sum + row.amountMinor, 0);
      const topCategory = rows[0];

      return {
        data: rows,
        summary:
          `Top category: ${topCategory.category} (${formatUsdMinor(topCategory.amountMinor)}). ` +
          `Total outgoing spend ${formatUsdMinor(totalSpendMinor)} across ${rows.length} categor${rows.length === 1 ? "y" : "ies"}.`,
      };
    },
  };
}

function inferCategory(description: string): string {
  const value = description.toUpperCase();

  if (hasAny(value, ["GROCERY", "WHOLEFOOD", "SUPERMARKET", "TRADER JOE", "WALMART"])) {
    return "groceries";
  }

  if (hasAny(value, ["UBER", "LYFT", "FUEL", "SHELL", "CHEVRON", "EXXON", "TRANSIT", "METRO"])) {
    return "transport";
  }

  if (hasAny(value, ["COFFEE", "CAFE", "STARBUCKS", "RESTAURANT", "DINER", "DOORDASH", "UBER EATS"])) {
    return "dining";
  }

  if (hasAny(value, ["ELECTRIC", "WATER", "INTERNET", "PHONE", "MOBILE", "UTILITY", "VERIZON", "COMCAST"])) {
    return "utilities";
  }

  if (hasAny(value, ["RENT", "MORTGAGE", "LANDLORD", "PROPERTY"])) {
    return "housing";
  }

  if (hasAny(value, ["PHARMACY", "HOSPITAL", "CLINIC", "MEDICAL", "DENTAL"])) {
    return "health";
  }

  if (hasAny(value, ["AMAZON", "TARGET", "STORE", "SHOP", "BEST BUY"])) {
    return "shopping";
  }

  return "other";
}

function hasAny(value: string, keywords: string[]): boolean {
  return keywords.some((keyword) => value.includes(keyword));
}
