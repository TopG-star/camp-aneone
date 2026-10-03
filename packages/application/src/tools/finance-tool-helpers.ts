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

export function inferSpendCategory(description: string): string {
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
