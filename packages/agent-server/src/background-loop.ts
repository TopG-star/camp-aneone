import type { CycleSummary } from "@oneon/application";
import type { Logger } from "@oneon/domain";

// ── Types ────────────────────────────────────────────────────

export type CycleRunner = () => Promise<CycleSummary>;
export type UserCycleRunner = (userId: string) => Promise<CycleSummary>;
export type EligibleUserProvider = () => string[];

export interface BackgroundLoopOptions {
  intervalMs: number;
  batchSize: number;
  maxDurationMs: number;
  maxConsecutiveErrors: number;
  backoffMultiplier: number;
  maxBackoffMs: number;
  maxUsersPerTick: number;
}

// ── BackgroundLoop ───────────────────────────────────────────

/**
 * Thin interval wrapper that runs a processing cycle on a timer.
 *
 * Features:
 * - Per-user iteration: queries eligible users each tick, runs cycle for each
 * - Overlap prevention: skips a tick if the previous cycle is still running
 * - Exponential backoff on consecutive errors
 * - Backoff resets on a successful cycle
 * - Graceful stop: awaits in-flight cycle before resolving
 * - Never throws: all errors caught and logged
 */
export class BackgroundLoop {
  private readonly userCycleRunner: UserCycleRunner;
  private readonly eligibleUserProvider: EligibleUserProvider;
  private readonly logger: Logger;
  private readonly options: BackgroundLoopOptions;

  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlightPromise: Promise<void> | null = null;
  private consecutiveErrors = 0;
  private nextRunAt = 0;
  private _lastCycleAt: string | null = null;
  private _lastError: string | null = null;

  constructor(
    userCycleRunner: UserCycleRunner,
    eligibleUserProvider: EligibleUserProvider,
    logger: Logger,
    options: BackgroundLoopOptions,
  ) {
    this.userCycleRunner = userCycleRunner;
    this.eligibleUserProvider = eligibleUserProvider;
    this.logger = logger;
    this.options = options;
  }

  start(): void {
    if (this.running) {
      this.logger.warn("BackgroundLoop.start() called but already running");
      return;
    }

    this.running = true;
    this.consecutiveErrors = 0;
    this.nextRunAt = 0;

    this.logger.info("Background processing loop started", {
      intervalMs: this.options.intervalMs,
      batchSize: this.options.batchSize,
      maxDurationMs: this.options.maxDurationMs,
    });

    // Run immediately
    this.executeCycle();

    // Schedule recurring ticks
    this.timer = setInterval(() => {
      this.tick();
    }, this.options.intervalMs);
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    this.running = false;

    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }

    // Wait for in-flight cycle to finish
    if (this.inFlightPromise !== null) {
      await this.inFlightPromise;
    }

    this.logger.info("Background processing loop stopped");
  }

  isRunning(): boolean {
    return this.running;
  }

  get lastCycleAt(): string | null {
    return this._lastCycleAt;
  }

  get lastError(): string | null {
    return this._lastError;
  }

  get errorCount(): number {
    return this.consecutiveErrors;
  }

  get isCycleInFlight(): boolean {
    return this.inFlightPromise !== null;
  }

  /**
   * Trigger an immediate cycle.
   * If userId is provided, runs only for that user.
   * If not, runs for all eligible users (used by timer ticks).
   */
  triggerNow(userId?: string): boolean {
    if (this.inFlightPromise !== null) {
      return false; // already running
    }
    this.executeCycle(userId);
    return true;
  }

  // ── Private ────────────────────────────────────────────────

  private tick(): void {
    // Overlap guard
    if (this.inFlightPromise !== null) {
      this.logger.debug("Skipping tick: previous cycle still in-flight");
      return;
    }

    // Backoff guard
    if (Date.now() < this.nextRunAt) {
      this.logger.debug("Skipping tick: in backoff period");
      return;
    }

    this.executeCycle();
  }

  private executeCycle(userId?: string): void {
    this.inFlightPromise = this.runCycleWrapped(userId);
  }

  private async runCycleWrapped(singleUserId?: string): Promise<void> {
    try {
      const userIds = singleUserId
        ? [singleUserId]
        : this.eligibleUserProvider().slice(0, this.options.maxUsersPerTick);

      if (userIds.length === 0) {
        this.logger.debug("No eligible users for processing cycle");
        this._lastCycleAt = new Date().toISOString();
        this._lastError = null;
        this.consecutiveErrors = 0;
        this.nextRunAt = 0;
        return;
      }

      const aggregated: CycleSummary = {
        classification: {
          total: 0,
          classified: 0,
          skippedByRule: 0,
          skippedMaxAttempts: 0,
          skippedDailyLimit: 0,
          failed: 0,
        },
        actionsProposed: 0,
        actionsAutoExecuted: 0,
        actionErrors: 0,
        notificationsSent: 0,
        abortedEarly: false,
        durationMs: 0,
      };

      let userErrors = 0;

      for (const userId of userIds) {
        try {
          const summary = await this.userCycleRunner(userId);
          aggregated.classification.total += summary.classification.total;
          aggregated.classification.classified += summary.classification.classified;
          aggregated.classification.skippedByRule += summary.classification.skippedByRule;
          aggregated.classification.skippedMaxAttempts += summary.classification.skippedMaxAttempts;
          aggregated.classification.skippedDailyLimit += summary.classification.skippedDailyLimit;
          aggregated.classification.failed += summary.classification.failed;
          aggregated.actionsProposed += summary.actionsProposed;
          aggregated.actionsAutoExecuted += summary.actionsAutoExecuted;
          aggregated.actionErrors += summary.actionErrors;
          aggregated.notificationsSent += summary.notificationsSent;
          aggregated.durationMs += summary.durationMs;
          if (summary.abortedEarly) aggregated.abortedEarly = true;
        } catch (userError) {
          userErrors++;
          this.logger.error("Processing cycle failed for user", {
            userId,
            error: userError instanceof Error ? userError.message : String(userError),
          });
        }
      }

      // If ALL users failed, treat as overall failure → trigger backoff
      if (userErrors === userIds.length) {
        this.consecutiveErrors++;
        this._lastCycleAt = new Date().toISOString();
        this._lastError = `All ${userErrors} user(s) failed`;

        const backoffMs = Math.min(
          this.options.intervalMs *
            Math.pow(this.options.backoffMultiplier, this.consecutiveErrors),
          this.options.maxBackoffMs
        );
        this.nextRunAt = Date.now() + backoffMs;

        this.logger.error("Processing cycle failed", {
          error: this._lastError,
          consecutiveErrors: this.consecutiveErrors,
          nextBackoffMs: backoffMs,
        });
        return;
      }

      // At least one user succeeded — reset backoff
      this.consecutiveErrors = 0;
      this.nextRunAt = 0;
      this._lastCycleAt = new Date().toISOString();
      this._lastError = null;

      this.logger.info("Processing cycle completed", {
        usersProcessed: userIds.length,
        userErrors,
        ...aggregated.classification,
        actionsProposed: aggregated.actionsProposed,
        actionsAutoExecuted: aggregated.actionsAutoExecuted,
        actionErrors: aggregated.actionErrors,
        abortedEarly: aggregated.abortedEarly,
        durationMs: aggregated.durationMs,
      });
    } catch (error) {
      this.consecutiveErrors++;
      this._lastCycleAt = new Date().toISOString();
      this._lastError = error instanceof Error ? error.message : String(error);

      const backoffMs = Math.min(
        this.options.intervalMs *
          Math.pow(this.options.backoffMultiplier, this.consecutiveErrors),
        this.options.maxBackoffMs
      );
      this.nextRunAt = Date.now() + backoffMs;

      this.logger.error("Processing cycle failed", {
        error: error instanceof Error ? error.message : String(error),
        consecutiveErrors: this.consecutiveErrors,
        nextBackoffMs: backoffMs,
      });
    } finally {
      this.inFlightPromise = null;
    }
  }
}
