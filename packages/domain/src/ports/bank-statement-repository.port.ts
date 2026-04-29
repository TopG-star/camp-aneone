import type {
  BankStatement,
  BankStatementIntakeStatus,
} from "../entities.js";
import type { Source } from "../enums.js";

export interface BankStatementRepository {
  upsert(statement: Omit<BankStatement, "id" | "createdAt" | "updatedAt">): BankStatement;
  findById(id: string): BankStatement | null;
  findBySourceAndExternalId(
    source: Source,
    externalId: string,
    userId?: string,
  ): BankStatement | null;
  findByStatus(
    status: BankStatementIntakeStatus,
    limit: number,
    userId?: string,
  ): BankStatement[];
  markQueuedForParse(id: string): void;
  markSkippedDuplicate(id: string): void;
  count(options?: {
    status?: BankStatementIntakeStatus;
    userId?: string;
  }): number;
}
