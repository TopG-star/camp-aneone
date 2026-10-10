import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CycleSummary } from "@oneon/application";
import type { Logger } from "@oneon/domain";

// ── Types ────────────────────────────────────────────────────

export type CycleRunner = () => Promise<CycleSummary>;
export type UserCycleRunner = (userId: string) => Promise<CycleSummary>;
export type EligibleUserProvider = () => string[];

export interface LoopErrorEvent {
  id: string;
  occurredAt: string;
  component: string;
  stage: string;
  userId: string | null;
  message: string;
}

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
  private readonly recentErrors: LoopErrorEvent[] = [];
  private static readonly MAX_RECENT_ERRORS = 100;

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
    this.recentErrors.length = 0;

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

  getRecentErrors(limit = 25, userId?: string): LoopErrorEvent[] {
    const normalizedLimit = Math.max(1, Math.min(limit, BackgroundLoop.MAX_RECENT_ERRORS));
    const filtered = userId
      ? this.recentErrors.filter((e) => e.userId === null || e.userId === userId)
      : this.recentErrors;
    return filtered.slice(0, normalizedLimit);
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
          pausedByPolicy: 0,
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
          aggregated.classification.pausedByPolicy += summary.classification.pausedByPolicy;
          aggregated.actionsProposed += summary.actionsProposed;
          aggregated.actionsAutoExecuted += summary.actionsAutoExecuted;
          aggregated.actionErrors += summary.actionErrors;
          aggregated.notificationsSent += summary.notificationsSent;
          aggregated.durationMs += summary.durationMs;
          if (summary.abortedEarly) aggregated.abortedEarly = true;

          if (summary.classification.failed > 0) {
            this.pushError({
              component: "classifier",
              stage: "classify",
              userId,
              message: `${summary.classification.failed} classification failure(s) in cycle`,
            });
          }

          if (summary.actionErrors > 0) {
            this.pushError({
              component: "actions",
              stage: "execute",
              userId,
              message: `${summary.actionErrors} action execution/proposal failure(s) in cycle`,
            });
          }
        } catch (userError) {
          userErrors++;
          const message =
            userError instanceof Error ? userError.message : String(userError);

          this.pushError({
            component: "processing_cycle",
            stage: "user_run",
            userId,
            message,
          });

          this.logger.error("Processing cycle failed for user", {
            userId,
            error: message,
          });
        }
      }

      // If ALL users failed, treat as overall failure → trigger backoff
      if (userErrors === userIds.length) {
        this.consecutiveErrors++;
        this._lastCycleAt = new Date().toISOString();
        this._lastError = `All ${userErrors} user(s) failed`;
        this.pushError({
          component: "processing_cycle",
          stage: "tick",
          userId: null,
          message: this._lastError,
        });

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
      this.pushError({
        component: "processing_cycle",
        stage: "loop",
        userId: null,
        message: this._lastError,
      });

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

  private pushError(error: {
    component: string;
    stage: string;
    userId: string | null;
    message: string;
  }): void {
    const entry: LoopErrorEvent = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      occurredAt: new Date().toISOString(),
      component: error.component,
      stage: error.stage,
      userId: error.userId,
      message: error.message,
    };

    this.recentErrors.unshift(entry);
    if (this.recentErrors.length > BackgroundLoop.MAX_RECENT_ERRORS) {
      this.recentErrors.length = BackgroundLoop.MAX_RECENT_ERRORS;
    }
  }
}

// ── BackupScheduler ──────────────────────────────────────────

export interface RestoreCheck {
  ok: boolean;
  integrity: string;
  contextMeta: { kind: string; tenant_id: string | null } | null;
}

export interface BackupSchedulerDeps {
  /** The folder backupAll writes `<yyyy-mm-dd>/` folders into. */
  outDir: string;
  backupAll: () => Promise<unknown>;
  restoreTest: (file: string) => Promise<RestoreCheck>;
  logger: Logger;
  now?: () => Date;
  /** How often to look at the clock. The jobs themselves run once per day and once per month. */
  checkIntervalMs?: number;
}

const DAY_FOLDER = /^\d{4}-\d{2}-\d{2}$/;
const NON_TENANT_BACKUPS = new Set(["control.db.enc", "personal.db.enc"]);

/**
 * Nightly encrypted backup (once per calendar day: today's folder existing means the day is done) and a monthly restore test
 * (one tenant from the latest backup, rotating). Same shape as the processing loop: a timer, no overlap, stop() awaits the tick
 * in flight, and nothing here ever throws. Backups are never deleted here; the operator prunes (B-retention adds deletion).
 */
export class BackupScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private lastRestoreMonth: string | null = null;
  private readonly now: () => Date;

  constructor(private readonly deps: BackupSchedulerDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  start(): void {
    if (this.timer !== null) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.deps.checkIntervalMs ?? 60 * 60 * 1000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.inFlight !== null) await this.inFlight;
  }

  /** One look at the clock: back up if today has no folder yet, test a restore if this month has had none. */
  tick(): Promise<void> {
    // Overlap guard, as in BackgroundLoop.
    if (this.inFlight !== null) return this.inFlight;
    this.inFlight = this.run().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async run(): Promise<void> {
    const { outDir, logger } = this.deps;
    const today = this.now().toISOString().slice(0, 10);
    if (!existsSync(join(outDir, today))) {
      try {
        await this.deps.backupAll();
        logger.info("Nightly backup done", { day: today });
      } catch (error) {
        logger.error("Nightly backup failed", { day: today, error: error instanceof Error ? error.message : String(error) });
      }
    }

    const month = today.slice(0, 7);
    if (this.lastRestoreMonth === month) return;
    try {
      const file = this.restoreCandidate();
      if (file === null) {
        logger.debug("Monthly restore test skipped: no tenant backup yet");
        return;
      }
      this.lastRestoreMonth = month;
      const result = await this.deps.restoreTest(file);
      if (result.ok) {
        logger.info("Monthly restore test passed", { file, tenantId: result.contextMeta?.tenant_id ?? null });
      } else {
        logger.error("Monthly restore test failed", { file, integrity: result.integrity, contextMeta: result.contextMeta });
      }
    } catch (error) {
      logger.error("Monthly restore test crashed", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** One tenant's file from the latest day folder that has any; the month number rotates through them. */
  private restoreCandidate(): string | null {
    const { outDir } = this.deps;
    if (!existsSync(outDir)) return null;
    const days = readdirSync(outDir)
      .filter((name) => DAY_FOLDER.test(name))
      .sort()
      .reverse();
    const date = this.now();
    for (const day of days) {
      const tenants = readdirSync(join(outDir, day))
        .filter((name) => name.endsWith(".db.enc") && !NON_TENANT_BACKUPS.has(name))
        .sort();
      if (tenants.length === 0) continue;
      const monthNumber = date.getUTCFullYear() * 12 + date.getUTCMonth();
      return join(outDir, day, tenants[monthNumber % tenants.length]!);
    }
    return null;
  }
}
