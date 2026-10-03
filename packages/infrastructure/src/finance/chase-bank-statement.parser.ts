import type { BankStatementParser, StatementDocument } from "@oneon/domain";

const CHASE_PARSER_ID = "chase_pdf";
const CHASE_PARSER_VERSION = 1;

export class ChaseBankStatementParser implements BankStatementParser {
  readonly id = CHASE_PARSER_ID;
  readonly version = CHASE_PARSER_VERSION;

  parseMetadata(input: {
    statement: Parameters<BankStatementParser["parseMetadata"]>[0]["statement"];
    document: StatementDocument;
  }) {
    const text = decodeStatementText(input.document);

    const accountLast4 = matchRequired(
      text,
      /account\s+(?:ending\s+(?:in\s+)?)?(?:number\s*)?(?:[#:]\s*)?(\d{4})/i,
      1,
    );

    const statementDateRaw = matchRequired(
      text,
      /statement\s+date\s*[:\-]\s*([0-9\/\-]{8,10})/i,
      1,
    );

    const periodStartRaw = matchRequired(
      text,
      /statement\s+period\s*[:\-]\s*([0-9\/\-]{8,10})\s*(?:-|to)\s*([0-9\/\-]{8,10})/i,
      1,
    );

    const periodEndRaw = matchRequired(
      text,
      /statement\s+period\s*[:\-]\s*([0-9\/\-]{8,10})\s*(?:-|to)\s*([0-9\/\-]{8,10})/i,
      2,
    );

    const openingBalanceRaw = matchRequired(
      text,
      /opening\s+balance\s*[:\-]\s*([()\-+\$0-9,\.]+)/i,
      1,
    );

    const closingBalanceRaw = matchRequired(
      text,
      /closing\s+balance\s*[:\-]\s*([()\-+\$0-9,\.]+)/i,
      1,
    );

    const currency =
      matchOptional(text, /currency\s*[:\-]\s*([A-Z]{3})/i, 1) ?? "USD";

    try {
      return {
        accountLast4,
        statementDate: normalizeDate(statementDateRaw),
        periodStart: normalizeDate(periodStartRaw),
        periodEnd: normalizeDate(periodEndRaw),
        currency: currency.toUpperCase(),
        openingBalanceMinor: parseMoneyMinor(openingBalanceRaw),
        closingBalanceMinor: parseMoneyMinor(closingBalanceRaw),
        parserId: CHASE_PARSER_ID,
        parserVersion: CHASE_PARSER_VERSION,
      };
    } catch {
      throw new Error("CHASE_METADATA_PARSE_FAILED");
    }
  }

  parseTransactions(input: {
    statement: Parameters<BankStatementParser["parseTransactions"]>[0]["statement"];
    document: StatementDocument;
    metadata?: Parameters<BankStatementParser["parseTransactions"]>[0]["metadata"];
  }) {
    const text = decodeStatementText(input.document);
    const transactions = text
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(parseTransactionLine)
      .filter((transaction): transaction is NonNullable<typeof transaction> =>
        transaction !== null,
      );

    if (transactions.length === 0) {
      throw new Error("CHASE_TRANSACTION_PARSE_FAILED");
    }

    return transactions;
  }
}

function decodeStatementText(document: StatementDocument): string {
  if (document.content.length === 0) {
    throw new Error("CHASE_DOCUMENT_EMPTY");
  }

  return new TextDecoder().decode(document.content);
}

function matchRequired(
  input: string,
  pattern: RegExp,
  groupIndex: number,
): string {
  const match = input.match(pattern);
  const value = match?.[groupIndex]?.trim();

  if (!value) {
    throw new Error("CHASE_METADATA_PARSE_FAILED");
  }

  return value;
}

function matchOptional(
  input: string,
  pattern: RegExp,
  groupIndex: number,
): string | null {
  const match = input.match(pattern);
  const value = match?.[groupIndex]?.trim();
  return value && value.length > 0 ? value : null;
}

function normalizeDate(raw: string): string {
  const normalized = raw.trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return normalized;
  }

  const slash = normalized.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!slash) {
    throw new Error("invalid date");
  }

  const month = slash[1].padStart(2, "0");
  const day = slash[2].padStart(2, "0");
  const year = slash[3];

  return `${year}-${month}-${day}`;
}

function parseMoneyMinor(raw: string): number {
  let value = raw.trim().replace(/[$,\s]/g, "");
  let sign = 1;

  if (value.startsWith("(") && value.endsWith(")")) {
    sign = -1;
    value = value.slice(1, -1);
  }

  if (value.startsWith("+")) {
    value = value.slice(1);
  } else if (value.startsWith("-")) {
    sign *= -1;
    value = value.slice(1);
  }

  const match = value.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) {
    throw new Error("invalid money");
  }

  const whole = Number(match[1]);
  const cents = Number((match[2] ?? "0").padEnd(2, "0"));

  return sign * (whole * 100 + cents);
}

function parseTransactionLine(line: string): {
  postedAt: string;
  description: string;
  amountMinor: number;
  balanceMinor: number | null;
  dedupeKey: string;
} | null {
  if (!line.includes("|")) {
    return null;
  }

  const parts = line
    .split("|")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (parts.length < 3) {
    return null;
  }

  const [postedAtRaw, descriptionRaw, amountRaw, balanceRaw] = parts;

  if (!/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(postedAtRaw) && !/^\d{4}-\d{2}-\d{2}$/.test(postedAtRaw)) {
    return null;
  }

  const postedAt = normalizeDate(postedAtRaw);

  let amountMinor: number;
  let balanceMinor: number | null = null;

  try {
    amountMinor = parseMoneyMinor(amountRaw);
    balanceMinor = balanceRaw ? parseMoneyMinor(balanceRaw) : null;
  } catch {
    return null;
  }

  const description = descriptionRaw.trim();
  const dedupeDescription = description
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

  return {
    postedAt,
    description,
    amountMinor,
    balanceMinor,
    dedupeKey: `${postedAt}|${dedupeDescription}|${amountMinor}`,
  };
}
