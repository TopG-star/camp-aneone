import { Router, type Request, type Response } from "express";
import type {
  BankStatement,
  BankStatementIntakeStatus,
  BankStatementRepository,
  Logger,
} from "@oneon/domain";

export interface FinanceStatementsRouteDeps {
  bankStatementRepo: BankStatementRepository;
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

export function createFinanceStatementsRouter(
  deps: FinanceStatementsRouteDeps,
): Router {
  const router = Router();
  const { bankStatementRepo, logger } = deps;

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