import type {
  BankStatement,
  BankStatementIntakeStatus,
  BankStatementRepository,
} from "@oneon/domain";

export const FINANCE_STATUSES: readonly BankStatementIntakeStatus[] = [
  "discovered",
  "metadata_parsed",
  "error_metadata",
  "transactions_parsed",
  "error_transactions",
];

export interface FinanceStatusCounts {
  discovered: number;
  metadataParsed: number;
  errorMetadata: number;
  transactionsParsed: number;
  errorTransactions: number;
  total: number;
}

export function resolveFinanceUserId(
  repo: Pick<BankStatementRepository, "findByStatus">,
  explicitUserId?: string,
): string | null {
  if (explicitUserId && explicitUserId.trim().length > 0) {
    return explicitUserId.trim();
  }

  for (const status of FINANCE_STATUSES) {
    const items = repo.findByStatus(status, 1);
    if (items.length > 0) {
      return items[0].userId;
    }
  }

  return null;
}

export function listRecentFinanceStatements(
  repo: Pick<BankStatementRepository, "findByStatus">,
  limit: number,
  userId: string,
): BankStatement[] {
  return FINANCE_STATUSES
    .flatMap((status) => repo.findByStatus(status, limit, userId))
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
    .slice(0, limit);
}

export function readFinanceStatusCounts(
  repo: Pick<BankStatementRepository, "count">,
  userId: string,
): FinanceStatusCounts {
  return {
    discovered: repo.count({ status: "discovered", userId }),
    metadataParsed: repo.count({ status: "metadata_parsed", userId }),
    errorMetadata: repo.count({ status: "error_metadata", userId }),
    transactionsParsed: repo.count({ status: "transactions_parsed", userId }),
    errorTransactions: repo.count({ status: "error_transactions", userId }),
    total: repo.count({ userId }),
  };
}

export function formatUsdMinor(amountMinor: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amountMinor / 100);
}
