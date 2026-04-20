export interface TransactionRunner {
  run<T>(fn: () => T): T;
}
