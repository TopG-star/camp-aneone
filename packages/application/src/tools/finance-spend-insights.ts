import { z } from "zod";
import type {
  BankStatementParseRepository,
  BankStatementParsedTransaction,
  BankStatementRepository,
} from "@oneon/domain";
import type { ToolDefinition, ToolResult } from "./tool-registry.js";
import {
  formatUsdMinor,
  inferSpendCategory,
  resolveFinanceUserId,
} from "./finance-tool-helpers.js";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const financeSpendInsightsSchema = z.object({
  from: z
    .string()
    .regex(DATE_PATTERN, "from must be in YYYY-MM-DD format")
    .optional(),
  to: z
    .string()
    .regex(DATE_PATTERN, "to must be in YYYY-MM-DD format")
    .optional(),
  limit: z.number().int().positive().max(2000).optional().default(400),
  userId: z.string().trim().min(1).optional(),
});

export type FinanceSpendInsightsInput = z.infer<typeof financeSpendInsightsSchema>;

export interface FinanceInsightSummary {
  inflowMinor: number;
  outflowMinor: number;
  netMinor: number;
  averageOutflowMinor: number;
  transactionCount: number;
  outflowCount: number;
}

export interface FinanceCategoryInsight {
  category: string;
  amountMinor: number;
  transactionCount: number;
}

export type FinanceAnomalySeverity = "high" | "medium";
export type FinanceAnomalyKind = "large_outflow" | "merchant_burst";

export interface FinanceAnomaly {
  id: string;
  kind: FinanceAnomalyKind;
  severity: FinanceAnomalySeverity;
  title: string;
  description: string;
  transactionId: string | null;
  postedAt: string | null;
  amountMinor: number | null;
}

export interface FinanceInsightsPeriod {
  from: string;
  to: string;
  generatedAt: string;
  sampleSize: number;
}

export interface FinanceSpendInsightsData {
  userId: string | null;
  summary: FinanceInsightSummary | null;
  topCategories: FinanceCategoryInsight[];
  anomalies: FinanceAnomaly[];
  period: FinanceInsightsPeriod | null;
}

export interface FinanceSpendInsightsDeps {
  bankStatementRepo: Pick<BankStatementRepository, "findByStatus">;
  bankStatementParseRepo: Pick<BankStatementParseRepository, "findTransactions">;
}

export function createFinanceSpendInsightsTool(
  deps: FinanceSpendInsightsDeps,
): ToolDefinition {
  const { bankStatementRepo, bankStatementParseRepo } = deps;

  return {
    name: "finance_spend_insights",
    version: "1.0.0",
    description:
      "Generate finance summaries and anomaly flags from parsed statement transactions.",
    inputSchema: financeSpendInsightsSchema,
    execute(validatedInput: unknown): ToolResult {
      const input = validatedInput as FinanceSpendInsightsInput;
      const userId = resolveFinanceUserId(bankStatementRepo, input.userId);

      if (!userId) {
        return {
          data: {
            userId: null,
            summary: null,
            topCategories: [],
            anomalies: [],
            period: null,
          } satisfies FinanceSpendInsightsData,
          summary: "No finance statements found yet.",
        };
      }

      const transactions = bankStatementParseRepo.findTransactions({
        userId,
        postedAtFrom: input.from,
        postedAtTo: input.to,
        limit: input.limit,
      });

      const data = buildFinanceSpendInsightsData(
        userId,
        transactions,
        new Date().toISOString(),
      );

      return {
        data,
        summary: summarizeFinanceInsights(data),
      };
    },
  };
}

export function buildFinanceSpendInsightsData(
  userId: string,
  transactions: BankStatementParsedTransaction[],
  generatedAt: string,
): FinanceSpendInsightsData {
  if (transactions.length === 0) {
    return {
      userId,
      summary: {
        inflowMinor: 0,
        outflowMinor: 0,
        netMinor: 0,
        averageOutflowMinor: 0,
        transactionCount: 0,
        outflowCount: 0,
      },
      topCategories: [],
      anomalies: [],
      period: {
        from: "",
        to: "",
        generatedAt,
        sampleSize: 0,
      },
    };
  }

  const ordered = [...transactions].sort((a, b) => a.postedAt.localeCompare(b.postedAt));
  const inflowMinor = ordered
    .filter((tx) => tx.amountMinor > 0)
    .reduce((sum, tx) => sum + tx.amountMinor, 0);

  const outgoing = ordered.filter((tx) => tx.amountMinor < 0);
  const outflowMinor = outgoing.reduce((sum, tx) => sum + Math.abs(tx.amountMinor), 0);
  const averageOutflowMinor = outgoing.length > 0
    ? Math.round(outflowMinor / outgoing.length)
    : 0;

  const topCategories = buildTopCategoryInsights(outgoing);
  const anomalies = buildAnomalyFlags(outgoing, averageOutflowMinor);

  return {
    userId,
    summary: {
      inflowMinor,
      outflowMinor,
      netMinor: inflowMinor - outflowMinor,
      averageOutflowMinor,
      transactionCount: ordered.length,
      outflowCount: outgoing.length,
    },
    topCategories,
    anomalies,
    period: {
      from: ordered[0]?.postedAt ?? "",
      to: ordered[ordered.length - 1]?.postedAt ?? "",
      generatedAt,
      sampleSize: ordered.length,
    },
  };
}

export function summarizeFinanceInsights(data: FinanceSpendInsightsData): string {
  if (!data.summary) {
    return "No finance statements found yet.";
  }

  if (data.summary.transactionCount === 0) {
    return "No parsed transactions found in the selected window.";
  }

  const anomalyCount = data.anomalies.length;
  const anomalySuffix = anomalyCount === 1 ? "anomaly" : "anomalies";

  return (
    `Net ${formatUsdMinor(data.summary.netMinor)} from ` +
    `${data.summary.transactionCount} transaction${data.summary.transactionCount === 1 ? "" : "s"}; ` +
    `outflow ${formatUsdMinor(data.summary.outflowMinor)}. ` +
    `Flagged ${anomalyCount} ${anomalySuffix}.`
  );
}

function buildTopCategoryInsights(
  outgoing: BankStatementParsedTransaction[],
): FinanceCategoryInsight[] {
  const grouped = new Map<string, FinanceCategoryInsight>();

  for (const tx of outgoing) {
    const category = inferSpendCategory(tx.description);
    const existing = grouped.get(category) ?? {
      category,
      amountMinor: 0,
      transactionCount: 0,
    };

    existing.amountMinor += Math.abs(tx.amountMinor);
    existing.transactionCount += 1;
    grouped.set(category, existing);
  }

  return [...grouped.values()]
    .sort((a, b) => b.amountMinor - a.amountMinor)
    .slice(0, 5);
}

function buildAnomalyFlags(
  outgoing: BankStatementParsedTransaction[],
  averageOutflowMinor: number,
): FinanceAnomaly[] {
  const anomalies: FinanceAnomaly[] = [];
  if (outgoing.length === 0) {
    return anomalies;
  }

  const largeThreshold = Math.max(10_000, Math.round(averageOutflowMinor * 1.8));

  const largeOutflows = [...outgoing]
    .filter((tx) => Math.abs(tx.amountMinor) >= largeThreshold)
    .sort((a, b) => Math.abs(b.amountMinor) - Math.abs(a.amountMinor))
    .slice(0, 3);

  for (const tx of largeOutflows) {
    const magnitude = Math.abs(tx.amountMinor);
    anomalies.push({
      id: `large-outflow:${tx.id}`,
      kind: "large_outflow",
      severity: magnitude >= 100_00 ? "high" : "medium",
      title: "Large outflow detected",
      description: `${tx.description} posted ${tx.postedAt} for ${formatUsdMinor(magnitude)}.`,
      transactionId: tx.id,
      postedAt: tx.postedAt,
      amountMinor: tx.amountMinor,
    });
  }

  const byMerchant = new Map<string, { count: number; totalMinor: number }>();
  for (const tx of outgoing) {
    const merchant = normalizeMerchant(tx.description);
    const existing = byMerchant.get(merchant) ?? { count: 0, totalMinor: 0 };
    existing.count += 1;
    existing.totalMinor += Math.abs(tx.amountMinor);
    byMerchant.set(merchant, existing);
  }

  for (const [merchant, stats] of byMerchant.entries()) {
    if (stats.count < 3 || stats.totalMinor < 50_00) {
      continue;
    }

    anomalies.push({
      id: `merchant-burst:${merchant}`,
      kind: "merchant_burst",
      severity: stats.count >= 5 ? "high" : "medium",
      title: "Repeated merchant spend",
      description: `${merchant} appears ${stats.count} times with ${formatUsdMinor(stats.totalMinor)} total outflow.`,
      transactionId: null,
      postedAt: null,
      amountMinor: -stats.totalMinor,
    });
  }

  return anomalies.slice(0, 8);
}

function normalizeMerchant(description: string): string {
  return description
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 3)
    .join(" ");
}
