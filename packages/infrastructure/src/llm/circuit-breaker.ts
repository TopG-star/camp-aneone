import type { Logger } from "@oneon/domain";

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  failureThreshold: number;
  resetTimeoutMs: number;
  logger: Logger;
}

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failureCount = 0;
  private lastFailureTime = 0;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly logger: Logger;

  constructor(options: CircuitBreakerOptions) {
    this.failureThreshold = options.failureThreshold;
    this.resetTimeoutMs = options.resetTimeoutMs;
    this.logger = options.logger;
  }

  getState(): CircuitState {
    if (this.state === "open") {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.resetTimeoutMs) {
        this.state = "half-open";
        this.logger.info("Circuit breaker transitioning to half-open", {
          elapsedMs: elapsed,
        });
      }
    }
    return this.state;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const currentState = this.getState();

    if (currentState === "open") {
      throw new CircuitOpenError(
        `Circuit breaker is open. Resets in ${this.resetTimeoutMs - (Date.now() - this.lastFailureTime)}ms`
      );
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure(error);
      throw error;
    }
  }

  private onSuccess(): void {
    if (this.state === "half-open") {
      this.logger.info("Circuit breaker closing after successful half-open call");
    }
    this.failureCount = 0;
    this.state = "closed";
  }

  private onFailure(error: unknown): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    const statusCode = extractStatusCode(error);
    const isFatal = statusCode === 401 || statusCode === 403;

    if (isFatal) {
      this.state = "open";
      this.logger.error("Circuit breaker opened due to fatal error", {
        statusCode,
        failureCount: this.failureCount,
      });
      return;
    }

    if (this.failureCount >= this.failureThreshold) {
      this.state = "open";
      this.logger.warn("Circuit breaker opened due to failure threshold", {
        failureCount: this.failureCount,
        threshold: this.failureThreshold,
      });
    }
  }

  /** Exposed for testing only */
  _reset(): void {
    this.state = "closed";
    this.failureCount = 0;
    this.lastFailureTime = 0;
  }
}

export class CircuitOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CircuitOpenError";
  }
}

function extractStatusCode(error: unknown): number | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof (error as Record<string, unknown>).status === "number"
  ) {
    return (error as Record<string, unknown>).status as number;
  }
  return undefined;
}
