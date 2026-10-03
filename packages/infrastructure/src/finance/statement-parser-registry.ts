import type {
  BankStatement,
  BankStatementParser,
  BankStatementParserRegistry,
  Source,
} from "@oneon/domain";

export interface BankStatementParserRegistration {
  senderDomains: string[];
  parser: BankStatementParser;
  sources?: Source[];
}

export class StaticBankStatementParserRegistry
  implements BankStatementParserRegistry
{
  private readonly registrations: Array<
    BankStatementParserRegistration & { senderDomainSet: Set<string> }
  >;

  constructor(registrations: BankStatementParserRegistration[]) {
    this.registrations = registrations.map((registration) => ({
      ...registration,
      senderDomainSet: new Set(
        registration.senderDomains.map((domain) => domain.trim().toLowerCase()),
      ),
    }));
  }

  resolve(statement: BankStatement): BankStatementParser | null {
    const senderDomain = statement.senderDomain.trim().toLowerCase();

    for (const registration of this.registrations) {
      if (
        registration.sources &&
        registration.sources.length > 0 &&
        !registration.sources.includes(statement.source)
      ) {
        continue;
      }

      if (registration.senderDomainSet.has(senderDomain)) {
        return registration.parser;
      }
    }

    return null;
  }
}
