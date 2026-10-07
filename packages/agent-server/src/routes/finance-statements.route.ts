import { Router, type Request, type Response } from "express";
import { buildFinanceSpendInsightsData } from "@oneon/application";
import type {
  BankStatement,
  BankStatementIntakeStatus,
  BankStatementParseRepository,
  BankStatementRepository,
  Logger,
} from "@oneon/domain";

export interface FinanceStatementsRouteDeps {
  bankStatementRepo: BankStatementRepository;
  bankStatementParseRepo: Pick<
    BankStatementParseRepository,
    "findMetadataByStatementId" | "findTransactions" | "findParseRuns"
  >;
  logger: Logger;
}

const VALID_STATUSES: readonly BankStatementIntakeStatus[] = [
  "discovered",
  "metadata_parsed",
  "error_metadata",
  "transactions_parsed",
  "error_transactions",
];

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_TRANSACTIONS_LIMIT = 100;
const MAX_TRANSACTIONS_LIMIT = 500;
const DEFAULT_STATEMENT_TRANSACTIONS_LIMIT = 200;
const MAX_STATEMENT_TRANSACTIONS_LIMIT = 1000;
const PARSE_RUN_LIMIT = 20;

export function createFinanceStatementsRouter(
  deps: FinanceStatementsRouteDeps,
): Router {
  const router = Router();
  const { bankStatementRepo, bankStatementParseRepo, logger } = deps;

  router.get("/", (req: Request, res: Response) => {
    try {
      const userId = req.userId!;

      const parsedStatus = parseStatusQuery(req.query.status);
      if (!parsedStatus.ok) {
        res.status(400).json({ error: parsedStatus.error });
        return;
      }

      const parsedLimit = parseLimitQuery(req.query.limit);
      if (!parsedLimit.ok) {
        res.status(400).json({ error: parsedLimit.error });
        return;
      }

      const status = parsedStatus.value;
      const limit = parsedLimit.value;

      const counts = {
        discovered: bankStatementRepo.count({ status: "discovered", userId }),
        metadataParsed: bankStatementRepo.count({ status: "metadata_parsed", userId }),
        errorMetadata: bankStatementRepo.count({ status: "error_metadata", userId }),
        transactionsParsed: bankStatementRepo.count({ status: "transactions_parsed", userId }),
        errorTransactions: bankStatementRepo.count({ status: "error_transactions", userId }),
        total: bankStatementRepo.count({ userId }),
      };

      const items = status
        ? bankStatementRepo.findByStatus(status, limit, userId)
        : listMergedByRecent(bankStatementRepo, limit, userId);

      res.status(200).json({
        filter: { status: status ?? null, limit },
        counts,
        items,
      });
    } catch (error) {
      logger.error("Failed to list finance statements", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/transactions", (req: Request, res: Response) => {
    try {
      const userId = req.userId!;

      const parsedSearch = parseOptionalStringQuery(req.query.q, "q");
      if (!parsedSearch.ok) {
        res.status(400).json({ error: parsedSearch.error });
        return;
      }

      const parsedFrom = parseDateQuery(req.query.from, "from");
      if (!parsedFrom.ok) {
        res.status(400).json({ error: parsedFrom.error });
        return;
      }

      const parsedTo = parseDateQuery(req.query.to, "to");
      if (!parsedTo.ok) {
        res.status(400).json({ error: parsedTo.error });
        return;
      }

      const parsedStatementId = parseOptionalStringQuery(
        req.query.statementId,
        "statementId",
      );
      if (!parsedStatementId.ok) {
        res.status(400).json({ error: parsedStatementId.error });
        return;
      }

      const parsedLimit = parseTransactionsLimitQuery(req.query.limit);
      if (!parsedLimit.ok) {
        res.status(400).json({ error: parsedLimit.error });
        return;
      }

      const statementId = parsedStatementId.value;
      if (statementId) {
        const statement = bankStatementRepo.findById(statementId);
        if (!statement || statement.userId !== userId) {
          res.status(404).json({ error: "Statement not found" });
          return;
        }
      }

      const items = bankStatementParseRepo.findTransactions({
        userId,
        statementId: statementId ?? undefined,
        searchText: parsedSearch.value ?? undefined,
        postedAtFrom: parsedFrom.value ?? undefined,
        postedAtTo: parsedTo.value ?? undefined,
        limit: parsedLimit.value,
      });

      res.status(200).json({
        filter: {
          q: parsedSearch.value,
          from: parsedFrom.value,
          to: parsedTo.value,
          statementId,
          limit: parsedLimit.value,
        },
        items,
      });
    } catch (error) {
      logger.error("Failed to query finance transactions", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/insights", (req: Request, res: Response) => {
    try {
      const userId = req.userId!;

      const parsedFrom = parseDateQuery(req.query.from, "from");
      if (!parsedFrom.ok) {
        res.status(400).json({ error: parsedFrom.error });
        return;
      }

      const parsedTo = parseDateQuery(req.query.to, "to");
      if (!parsedTo.ok) {
        res.status(400).json({ error: parsedTo.error });
        return;
      }

      const parsedLimit = parseTransactionsLimitQuery(req.query.limit);
      if (!parsedLimit.ok) {
        res.status(400).json({ error: parsedLimit.error });
        return;
      }

      const transactions = bankStatementParseRepo.findTransactions({
        userId,
        postedAtFrom: parsedFrom.value ?? undefined,
        postedAtTo: parsedTo.value ?? undefined,
        limit: parsedLimit.value,
      });

      const insights = buildFinanceSpendInsightsData(
        userId,
        transactions,
        new Date().toISOString(),
      );

      res.status(200).json({
        filter: {
          from: parsedFrom.value,
          to: parsedTo.value,
          limit: parsedLimit.value,
        },
        counts: {
          discovered: bankStatementRepo.count({ status: "discovered", userId }),
          metadataParsed: bankStatementRepo.count({ status: "metadata_parsed", userId }),
          errorMetadata: bankStatementRepo.count({ status: "error_metadata", userId }),
          transactionsParsed: bankStatementRepo.count({ status: "transactions_parsed", userId }),
          errorTransactions: bankStatementRepo.count({ status: "error_transactions", userId }),
          total: bankStatementRepo.count({ userId }),
        },
        ...insights,
      });
    } catch (error) {
      logger.error("Failed to build finance insights", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/:statementId", (req: Request, res: Response) => {
    try {
      const userId = req.userId!;
      const statementId = req.params.statementId;
      if (Array.isArray(statementId) || typeof statementId !== "string") {
        res.status(400).json({ error: "statementId must be a string" });
        return;
      }

      const statement = bankStatementRepo.findById(statementId);
      if (!statement || statement.userId !== userId) {
        res.status(404).json({ error: "Statement not found" });
        return;
      }

      const parsedTransactionLimit = parseStatementTransactionsLimitQuery(
        req.query.transactionLimit,
      );
      if (!parsedTransactionLimit.ok) {
        res.status(400).json({ error: parsedTransactionLimit.error });
        return;
      }

      const metadata = bankStatementParseRepo.findMetadataByStatementId(
        statement.id,
        userId,
      );
      const transactions = bankStatementParseRepo.findTransactions({
        userId,
        statementId: statement.id,
        limit: parsedTransactionLimit.value,
      });
      const parseRuns = bankStatementParseRepo.findParseRuns({
        statementId: statement.id,
        userId,
        limit: PARSE_RUN_LIMIT,
      });

      res.status(200).json({
        statement,
        metadata,
        transactions,
        parseRuns,
      });
    } catch (error) {
      logger.error("Failed to fetch finance statement detail", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

function listMergedByRecent(
  repo: BankStatementRepository,
  limit: number,
  userId: string,
): BankStatement[] {
  return VALID_STATUSES
    .flatMap((status) => repo.findByStatus(status, limit, userId))
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
    .slice(0, limit);
}

function parseStatusQuery(
  value: Request["query"]["status"],
):
  | { ok: true; value: BankStatementIntakeStatus | null }
  | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true, value: null };
  }

  if (Array.isArray(value)) {
    return { ok: false, error: "status must be a single value" };
  }

  if (typeof value !== "string") {
    return { ok: false, error: "status must be a string" };
  }

  if (!VALID_STATUSES.includes(value as BankStatementIntakeStatus)) {
    return {
      ok: false,
      error:
        'status must be one of "discovered", "metadata_parsed", "error_metadata", "transactions_parsed", or "error_transactions"',
    };
  }

  return { ok: true, value: value as BankStatementIntakeStatus };
}

function parseLimitQuery(
  value: Request["query"]["limit"],
): { ok: true; value: number } | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true, value: DEFAULT_LIMIT };
  }

  if (Array.isArray(value)) {
    return { ok: false, error: "limit must be a single value" };
  }

  if (typeof value !== "string") {
    return { ok: false, error: "limit must be a number between 1 and 200" };
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
    return { ok: false, error: "limit must be a number between 1 and 200" };
  }

  return { ok: true, value: parsed };
}

function parseTransactionsLimitQuery(
  value: Request["query"]["limit"],
): { ok: true; value: number } | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true, value: DEFAULT_TRANSACTIONS_LIMIT };
  }

  if (Array.isArray(value)) {
    return { ok: false, error: "limit must be a single value" };
  }

  if (typeof value !== "string") {
    return { ok: false, error: "limit must be a number between 1 and 500" };
  }

  const parsed = Number(value);
  if (
    !Number.isInteger(parsed) ||
    parsed < 1 ||
    parsed > MAX_TRANSACTIONS_LIMIT
  ) {
    return { ok: false, error: "limit must be a number between 1 and 500" };
  }

  return { ok: true, value: parsed };
}

function parseStatementTransactionsLimitQuery(
  value: Request["query"]["transactionLimit"],
): { ok: true; value: number } | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true, value: DEFAULT_STATEMENT_TRANSACTIONS_LIMIT };
  }

  if (Array.isArray(value)) {
    return { ok: false, error: "transactionLimit must be a single value" };
  }

  if (typeof value !== "string") {
    return {
      ok: false,
      error: "transactionLimit must be a number between 1 and 1000",
    };
  }

  const parsed = Number(value);
  if (
    !Number.isInteger(parsed) ||
    parsed < 1 ||
    parsed > MAX_STATEMENT_TRANSACTIONS_LIMIT
  ) {
    return {
      ok: false,
      error: "transactionLimit must be a number between 1 and 1000",
    };
  }

  return { ok: true, value: parsed };
}

function parseOptionalStringQuery(
  value: Request["query"]["q"],
  fieldName: string,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true, value: null };
  }

  if (Array.isArray(value)) {
    return { ok: false, error: `${fieldName} must be a single value` };
  }

  if (typeof value !== "string") {
    return { ok: false, error: `${fieldName} must be a string` };
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { ok: true, value: null };
  }

  return { ok: true, value: trimmed };
}

function parseDateQuery(
  value: Request["query"]["from"],
  fieldName: "from" | "to",
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true, value: null };
  }

  if (Array.isArray(value)) {
    return { ok: false, error: `${fieldName} must be a single value` };
  }

  if (typeof value !== "string") {
    return { ok: false, error: `${fieldName} must be in YYYY-MM-DD format` };
  }

  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return { ok: false, error: `${fieldName} must be in YYYY-MM-DD format` };
  }

  return { ok: true, value: trimmed };
}