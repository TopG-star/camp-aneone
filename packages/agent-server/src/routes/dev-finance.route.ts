import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { parseBankStatements } from "@oneon/application";
import type {
  BankStatementParseRepository,
  BankStatementParserRegistry,
  BankStatementRepository,
  Logger,
  StatementDocument,
  User,
  UserRepository,
} from "@oneon/domain";

export interface DevFinanceRouteDeps {
  userRepo: UserRepository;
  bankStatementRepo: BankStatementRepository;
  bankStatementParseRepo: BankStatementParseRepository;
  bankStatementParserRegistry: BankStatementParserRegistry;
  allowedEmails: string[];
  maxTransactionRetries: number;
  logger: Logger;
}

const DEFAULT_SENDER = "alerts@chase.com";
const DEFAULT_SUBJECT = "Your monthly statement is ready";
const DEFAULT_RULE_VERSION = "dev-smoke-v1";
const DEFAULT_MIME_TYPE = "text/plain";
const DEFAULT_TRANSACTION_LIMIT = 200;
const DEFAULT_PARSE_RUN_LIMIT = 20;

const DEFAULT_STATEMENT_TEXT = [
  "Account ending in 1234",
  "Statement Date: 04/30/2026",
  "Statement Period: 04/01/2026 - 04/30/2026",
  "Opening Balance: $1,200.00",
  "Closing Balance: $1,055.30",
  "",
  "04/20/2026 | Coffee Shop | -4.50 | 1093.00",
  "04/21/2026 | Payroll | 2000.00 | 3093.00",
].join("\n");

export function createDevFinanceRouter(deps: DevFinanceRouteDeps): Router {
  const router = Router();

  router.post("/ingest-statement", async (req: Request, res: Response) => {
    try {
      const allowedEmails = deps.allowedEmails.map((email) =>
        email.trim().toLowerCase(),
      );
      if (allowedEmails.length === 0) {
        res.status(500).json({
          error: "No allowed emails configured; cannot resolve user for dev ingest",
        });
        return;
      }

      const parsedUserEmail = parseUserEmail(req.body?.userEmail, allowedEmails);
      if (!parsedUserEmail.ok) {
        res.status(parsedUserEmail.status).json({ error: parsedUserEmail.error });
        return;
      }

      const parsedSender = parseOptionalText(req.body?.sender, "sender");
      if (!parsedSender.ok) {
        res.status(400).json({ error: parsedSender.error });
        return;
      }

      const parsedSubject = parseOptionalText(req.body?.subject, "subject");
      if (!parsedSubject.ok) {
        res.status(400).json({ error: parsedSubject.error });
        return;
      }

      const parsedStatementText = parseStatementText(req.body?.statementText);
      if (!parsedStatementText.ok) {
        res.status(400).json({ error: parsedStatementText.error });
        return;
      }

      const parsedReceivedAt = parseReceivedAt(req.body?.receivedAt);
      if (!parsedReceivedAt.ok) {
        res.status(400).json({ error: parsedReceivedAt.error });
        return;
      }

      const userResolution = ensureUser(deps.userRepo, parsedUserEmail.value);

      const createdStatement = deps.bankStatementRepo.upsert({
        userId: userResolution.user.id,
        source: "gmail",
        externalId: `dev-smoke-${Date.now()}-${randomUUID().slice(0, 8)}`,
        messageId: `dev-smoke-message-${Date.now()}`,
        threadId: `dev-smoke-thread-${Date.now()}`,
        sender: parsedSender.value ?? DEFAULT_SENDER,
        senderDomain: extractSenderDomain(parsedSender.value ?? DEFAULT_SENDER),
        subject: parsedSubject.value ?? DEFAULT_SUBJECT,
        receivedAt: parsedReceivedAt.value,
        status: "discovered",
        detectionRuleVersion: DEFAULT_RULE_VERSION,
      });

      const statementDocumentById = new Map<string, StatementDocument>([
        [
          createdStatement.id,
          {
            mimeType: DEFAULT_MIME_TYPE,
            content: new TextEncoder().encode(parsedStatementText.value),
            fileName: "dev-smoke-statement.txt",
          },
        ],
      ]);

      const parseSummary = await parseBankStatements(
        {
          bankStatementRepo: deps.bankStatementRepo,
          parseRepo: deps.bankStatementParseRepo,
          parserRegistry: deps.bankStatementParserRegistry,
          documentProvider: {
            getStatementDocument: async (statement) => {
              return statementDocumentById.get(statement.id) ?? null;
            },
          },
          logger: deps.logger,
        },
        {
          userId: userResolution.user.id,
          batchSize: 1,
          maxTransactionRetries: deps.maxTransactionRetries,
        },
      );

      const statement = deps.bankStatementRepo.findById(createdStatement.id);
      const metadata = deps.bankStatementParseRepo.findMetadataByStatementId(
        createdStatement.id,
        userResolution.user.id,
      );
      const transactions = deps.bankStatementParseRepo.findTransactions({
        userId: userResolution.user.id,
        statementId: createdStatement.id,
        limit: DEFAULT_TRANSACTION_LIMIT,
      });
      const parseRuns = deps.bankStatementParseRepo.findParseRuns({
        statementId: createdStatement.id,
        userId: userResolution.user.id,
        limit: DEFAULT_PARSE_RUN_LIMIT,
      });

      res.status(200).json({
        user: {
          id: userResolution.user.id,
          email: userResolution.user.email,
          created: userResolution.created,
        },
        statement,
        metadata,
        transactions,
        parseRuns,
        parseSummary,
      });
    } catch (error) {
      deps.logger.error("Dev finance ingest failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

function ensureUser(
  userRepo: UserRepository,
  email: string,
): { user: User; created: boolean } {
  const existing = userRepo.findByEmail(email);
  if (existing) {
    return { user: existing, created: false };
  }

  const user = userRepo.upsert({
    id: randomUUID(),
    email,
  });

  return { user, created: true };
}

function parseUserEmail(
  value: unknown,
  allowedEmails: string[],
):
  | { ok: true; value: string }
  | { ok: false; status: 400 | 403; error: string } {
  if (value === undefined || value === null) {
    return { ok: true, value: allowedEmails[0] };
  }

  if (typeof value !== "string") {
    return {
      ok: false,
      status: 400,
      error: "userEmail must be a string",
    };
  }

  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) {
    return {
      ok: false,
      status: 400,
      error: "userEmail must not be empty",
    };
  }

  if (!allowedEmails.includes(normalized)) {
    return {
      ok: false,
      status: 403,
      error: "userEmail is not in the allowed list",
    };
  }

  return { ok: true, value: normalized };
}

function parseOptionalText(
  value: unknown,
  fieldName: string,
):
  | { ok: true; value: string | null }
  | { ok: false; error: string } {
  if (value === undefined || value === null) {
    return { ok: true, value: null };
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

function parseStatementText(
  value: unknown,
):
  | { ok: true; value: string }
  | { ok: false; error: string } {
  if (value === undefined || value === null) {
    return { ok: true, value: DEFAULT_STATEMENT_TEXT };
  }

  if (typeof value !== "string") {
    return { ok: false, error: "statementText must be a string" };
  }

  if (value.trim().length === 0) {
    return { ok: false, error: "statementText must not be empty when provided" };
  }

  return { ok: true, value };
}

function parseReceivedAt(
  value: unknown,
):
  | { ok: true; value: string }
  | { ok: false; error: string } {
  if (value === undefined || value === null) {
    return { ok: true, value: new Date().toISOString() };
  }

  if (typeof value !== "string") {
    return { ok: false, error: "receivedAt must be an ISO-8601 string" };
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return { ok: false, error: "receivedAt must be an ISO-8601 string" };
  }

  return { ok: true, value: parsed.toISOString() };
}

function extractSenderDomain(sender: string): string {
  const emailMatch = sender.match(/[a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,})/i);
  return emailMatch ? emailMatch[1].toLowerCase() : "";
}
