import type Database from "better-sqlite3";
import type { TransactionRunner } from "@oneon/domain";

export class SqliteTransactionRunner implements TransactionRunner {
  constructor(private readonly db: Database.Database) {}

  run<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
