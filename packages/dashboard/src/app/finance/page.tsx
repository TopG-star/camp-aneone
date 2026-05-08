"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  useFinanceInsights,
  useFinanceStatements,
  useFinanceTransactions,
} from "@/lib/hooks";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, Filter } from "lucide-react";
import { getMotionDelayClass } from "@/lib/motion-utils";

type StatementStatus =
  | "all"
  | "discovered"
  | "metadata_parsed"
  | "error_metadata"
  | "transactions_parsed"
  | "error_transactions";

interface FinanceStatementItem {
  id: string;
  source: string;
  subject: string;
  sender: string;
  receivedAt: string;
  status: Exclude<StatementStatus, "all">;
}

interface FinanceStatementsResponse {
  counts: {
    discovered: number;
    metadataParsed: number;
    errorMetadata: number;
    transactionsParsed: number;
    errorTransactions: number;
    total: number;
  };
  items: FinanceStatementItem[];
}

interface FinanceTransactionItem {
  id: string;
  statementId: string;
  postedAt: string;
  description: string;
  amountMinor: number;
}

interface FinanceTransactionsResponse {
  items: FinanceTransactionItem[];
}

interface FinanceInsightsResponse {
  summary: {
    inflowMinor: number;
    outflowMinor: number;
    netMinor: number;
    averageOutflowMinor: number;
    transactionCount: number;
    outflowCount: number;
  } | null;
  topCategories: Array<{
    category: string;
    amountMinor: number;
    transactionCount: number;
  }>;
  anomalies: Array<{
    id: string;
    kind: "large_outflow" | "merchant_burst";
    severity: "high" | "medium";
    title: string;
    description: string;
    postedAt: string | null;
    amountMinor: number | null;
  }>;
}

const STATUS_OPTIONS: readonly StatementStatus[] = [
  "all",
  "discovered",
  "metadata_parsed",
  "transactions_parsed",
  "error_metadata",
  "error_transactions",
];

function statusLabel(status: StatementStatus): string {
  if (status === "all") return "All";
  return status.replace(/_/g, " ");
}

function formatMinorCurrency(amountMinor: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(amountMinor / 100);
}

function statusBadgeVariant(status: FinanceStatementItem["status"]) {
  if (status.startsWith("error")) return "error" as const;
  if (status === "transactions_parsed") return "success" as const;
  return "default" as const;
}

function anomalyBadgeVariant(severity: "high" | "medium") {
  if (severity === "high") return "error" as const;
  return "warning" as const;
}

export default function FinancePage() {
  const [status, setStatus] = useState<StatementStatus>("all");
  const [search, setSearch] = useState("");

  const statementsQuery = useMemo(() => {
    const params = new URLSearchParams({ limit: "50" });
    if (status !== "all") {
      params.set("status", status);
    }
    return params.toString();
  }, [status]);

  const transactionsQuery = useMemo(() => {
    const params = new URLSearchParams({ limit: "25" });
    if (search.trim()) {
      params.set("q", search.trim());
    }
    return params.toString();
  }, [search]);

  const insightsQuery = useMemo(() => {
    const params = new URLSearchParams({ limit: "400" });
    return params.toString();
  }, []);

  const {
    data: statementsData,
    error: statementsError,
    isLoading: statementsLoading,
  } = useFinanceStatements(statementsQuery);

  const {
    data: transactionsData,
    error: transactionsError,
    isLoading: transactionsLoading,
  } = useFinanceTransactions(transactionsQuery);

  const {
    data: insightsData,
    error: insightsError,
    isLoading: insightsLoading,
  } = useFinanceInsights(insightsQuery);

  const statements = statementsData as FinanceStatementsResponse | undefined;
  const transactions = transactionsData as FinanceTransactionsResponse | undefined;
  const insights = insightsData as FinanceInsightsResponse | undefined;

  return (
    <div className="space-y-6 md:space-y-7 lg:space-y-8 motion-page-enter">
      <div className="space-y-2 motion-rise-in">
        <p className="page-eyebrow">
          Finance Intelligence
        </p>
        <h1 className="page-title">
          Finance
        </h1>
        <p className="page-copy">
          Review statement ingestion and parsed transactions.
        </p>
        <p className="text-label-md meta-copy">
          Use chat for natural-language queries or inspect raw data here.
          <Link
            href="/chat"
            className="ml-1 font-medium text-on-surface hover:underline dark:text-dark-on-surface"
          >
            Open Chat
          </Link>
        </p>
      </div>

      <div className={`motion-rise-in-soft space-y-2 ${getMotionDelayClass(1)}`}>
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-on-surface-variant dark:text-dark-on-surface-variant" />
          <span className="text-label-sm text-on-surface-variant dark:text-dark-on-surface-variant">
            Statement status
          </span>
        </div>

        <div className="flex gap-1 overflow-x-auto pb-1">
          {STATUS_OPTIONS.map((option) => (
            <button
              key={option}
              onClick={() => setStatus(option)}
              className={`filter-chip ${
                status === option ? "filter-chip-active" : "filter-chip-idle"
              }`}
            >
              {statusLabel(option)}
            </button>
          ))}
        </div>
      </div>

      {statements && (
        <div className={`grid gap-3 md:grid-cols-2 xl:grid-cols-4 ${getMotionDelayClass(2)}`}>
          <Card className="motion-rise-in-soft">
            <CardContent className="pt-6">
              <p className="text-label-md meta-copy">Total statements</p>
              <p className="text-2xl font-bold">{statements.counts.total}</p>
            </CardContent>
          </Card>
          <Card className="motion-rise-in-soft">
            <CardContent className="pt-6">
              <p className="text-label-md meta-copy">Transactions parsed</p>
              <p className="text-2xl font-bold">{statements.counts.transactionsParsed}</p>
            </CardContent>
          </Card>
          <Card className="motion-rise-in-soft">
            <CardContent className="pt-6">
              <p className="text-label-md meta-copy">Awaiting parse</p>
              <p className="text-2xl font-bold">
                {statements.counts.discovered + statements.counts.metadataParsed}
              </p>
            </CardContent>
          </Card>
          <Card className="motion-rise-in-soft">
            <CardContent className="pt-6">
              <p className="text-label-md meta-copy">Errors</p>
              <p className="text-2xl font-bold">
                {statements.counts.errorMetadata + statements.counts.errorTransactions}
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      <Card className={`motion-rise-in-soft ${getMotionDelayClass(3)}`}>
        <CardHeader>
          <CardTitle>Insights and Anomaly Flags</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {insightsLoading && (
            <div className="space-y-3">
              {[1, 2].map((i) => (
                <div key={i} className="state-skeleton h-16" />
              ))}
            </div>
          )}

          {insightsError && (
            <div className="state-content state-content-center py-8">
              <AlertTriangle className="h-8 w-8 text-red-500/80 dark:text-red-400/80" />
              <p className="state-error">Failed to load finance insights.</p>
            </div>
          )}

          {insights && insights.summary && (
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-eight bg-surface-low p-3 dark:bg-dark-surface-low">
                <p className="text-label-sm meta-copy">Net</p>
                <p className="font-semibold text-on-surface dark:text-dark-on-surface">
                  {formatMinorCurrency(insights.summary.netMinor)}
                </p>
              </div>
              <div className="rounded-eight bg-surface-low p-3 dark:bg-dark-surface-low">
                <p className="text-label-sm meta-copy">Outflow</p>
                <p className="font-semibold text-on-surface dark:text-dark-on-surface">
                  {formatMinorCurrency(insights.summary.outflowMinor)}
                </p>
              </div>
              <div className="rounded-eight bg-surface-low p-3 dark:bg-dark-surface-low">
                <p className="text-label-sm meta-copy">Inflow</p>
                <p className="font-semibold text-on-surface dark:text-dark-on-surface">
                  {formatMinorCurrency(insights.summary.inflowMinor)}
                </p>
              </div>
            </div>
          )}

          {insights && insights.anomalies.length > 0 ? (
            <div className="space-y-2">
              {insights.anomalies.slice(0, 5).map((anomaly) => (
                <div
                  key={anomaly.id}
                  className="rounded-eight border border-outline-variant/30 bg-surface-low p-3 dark:border-dark-outline-variant/35 dark:bg-dark-surface-low"
                >
                  <div className="mb-1 flex items-center gap-2">
                    <Badge variant={anomalyBadgeVariant(anomaly.severity)}>
                      {anomaly.severity}
                    </Badge>
                    <p className="font-medium text-on-surface dark:text-dark-on-surface">
                      {anomaly.title}
                    </p>
                  </div>
                  <p className="text-label-md meta-copy">{anomaly.description}</p>
                </div>
              ))}
            </div>
          ) : (
            insights && !insightsLoading && (
              <div className="state-content state-content-center py-4">
                <p className="state-subtext">No anomaly flags in the current sample window.</p>
              </div>
            )
          )}

          {insights && insights.topCategories.length > 0 && (
            <div className="space-y-2">
              <p className="text-label-sm text-on-surface-variant dark:text-dark-on-surface-variant">
                Top spend categories
              </p>
              <div className="flex flex-wrap gap-2">
                {insights.topCategories.slice(0, 4).map((row) => (
                  <Badge key={row.category}>
                    {row.category}: {formatMinorCurrency(row.amountMinor)}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-5 md:gap-6 lg:grid-cols-2">
        <Card className={`motion-rise-in-soft ${getMotionDelayClass(4)}`}>
          <CardHeader>
            <CardTitle>Statements</CardTitle>
          </CardHeader>
          <CardContent>
            {statementsLoading && (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="state-skeleton h-16" />
                ))}
              </div>
            )}

            {statementsError && (
              <div className="state-content state-content-center py-8">
                <AlertTriangle className="h-8 w-8 text-red-500/80 dark:text-red-400/80" />
                <p className="state-error">Failed to load finance statements.</p>
              </div>
            )}

            {statements && statements.items.length === 0 && (
              <div className="state-content state-content-center py-8">
                <p className="state-title">No statements for this filter.</p>
              </div>
            )}

            {statements && statements.items.length > 0 && (
              <div className="space-y-3">
                {statements.items.map((item) => (
                  <div
                    key={item.id}
                    className="rounded-eight bg-surface-low p-3 dark:bg-dark-surface-low"
                  >
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <Badge variant={statusBadgeVariant(item.status)}>{statusLabel(item.status)}</Badge>
                      <span className="text-label-sm meta-copy">
                        {new Date(item.receivedAt).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                      </span>
                    </div>
                    <p className="font-medium text-on-surface dark:text-dark-on-surface">
                      {item.subject}
                    </p>
                    <p className="text-sm meta-copy">
                      {item.sender} · {item.source}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className={`motion-rise-in-soft ${getMotionDelayClass(5)}`}>
          <CardHeader>
            <CardTitle>Transactions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search descriptions"
              className="w-full rounded-eight border border-outline-variant/30 bg-surface px-3 py-2 text-sm text-on-surface outline-none ring-offset-2 transition focus-visible:ring-2 focus-visible:ring-primary/40 dark:border-dark-outline-variant/35 dark:bg-dark-surface dark:text-dark-on-surface dark:focus-visible:ring-dark-primary/45"
            />

            {transactionsLoading && (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="state-skeleton h-14" />
                ))}
              </div>
            )}

            {transactionsError && (
              <div className="state-content state-content-center py-8">
                <AlertTriangle className="h-8 w-8 text-red-500/80 dark:text-red-400/80" />
                <p className="state-error">Failed to load finance transactions.</p>
              </div>
            )}

            {transactions && transactions.items.length === 0 && (
              <div className="state-content state-content-center py-8">
                <p className="state-title">No transactions found.</p>
              </div>
            )}

            {transactions && transactions.items.length > 0 && (
              <div className="space-y-3">
                {transactions.items.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-start justify-between gap-3 rounded-eight bg-surface-low p-3 dark:bg-dark-surface-low"
                  >
                    <div>
                      <p className="font-medium text-on-surface dark:text-dark-on-surface">
                        {item.description}
                      </p>
                      <p className="text-label-md meta-copy">
                        {new Date(item.postedAt).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                      </p>
                    </div>
                    <p className="font-semibold text-on-surface dark:text-dark-on-surface">
                      {formatMinorCurrency(item.amountMinor)}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
