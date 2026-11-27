import { Logger } from "@bunest/core";
import type {
  CronOptions,
  CronTime,
  ParsedCronExpression,
} from "../interfaces/scheduler.interface";
import {
  InMemorySchedulerLockDriver,
  type CronLockMode,
  type CronLockOptions,
  type SchedulerLockDriver,
} from "../scheduler-lock";
import {
  CronExpressionError,
  getNextCronDate,
  parseCronExpression,
  validateTimeZone,
  validateUtcOffset,
} from "./cron-parser";

const MAX_TIMEOUT_MS = 2_147_483_647;
const DEFAULT_THRESHOLD_MS = 250;

/**
 * Scheduled cron job backed by self-rescheduling timers, supporting overlap
 * protection (`waitForCompletion`), distributed locking (`lock` in `"skip"` or
 * `"leader"` mode), IANA timezones, fixed `utcOffset`, `Date` one-shot
 * schedules, missed-deadline `threshold`, `unrefTimeout`, `initialDelay`,
 * and clean teardown.
 */
export class CronJob {
  public readonly name: string;
  public readonly parsed?: ParsedCronExpression;
  public readonly targetDate?: Date;
  public readonly timeZone?: string;
  public readonly utcOffset?: number;
  public readonly waitForCompletion: boolean;
  public readonly unrefTimeout: boolean;
  public readonly threshold: number;
  public readonly initialDelay?: number;
  public readonly disabled: boolean;
  public readonly lock?: CronLockOptions;
  public readonly lockKey?: string;
  private readonly lockDriver?: SchedulerLockDriver;
  private readonly lockMode: CronLockMode;
  private readonly lockRenewIntervalMs: number;
  private readonly onError?: (error: unknown, jobName: string) => void;
  private readonly onComplete?: () => unknown | Promise<unknown>;
  private readonly logger = new Logger("CronJob");

  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private inFlight = false;
  private activeTickPromise?: Promise<void>;
  private lastRunDate?: Date;
  private skippedTicksCount = 0;

  private leaderToken?: string;
  private leaderHeld = false;
  private leaderGeneration = 0;
  private leaderAcquirePromise?: Promise<boolean>;
  private leaderRenewTimer?: ReturnType<typeof setInterval>;
  private readonly activeTickRenewTimers = new Set<
    ReturnType<typeof setInterval>
  >();

  constructor(
    expressionOrDate: CronTime,
    private readonly onTick: () => unknown | Promise<unknown>,
    options: CronOptions = {},
  ) {
    if (options.timeZone !== undefined && options.utcOffset !== undefined) {
      throw new CronExpressionError(
        `CronJob "${options.name ?? String(expressionOrDate)}" cannot specify both "timeZone" and "utcOffset".`,
      );
    }

    if (options.timeZone !== undefined) {
      validateTimeZone(options.timeZone);
    }
    if (options.utcOffset !== undefined) {
      validateUtcOffset(options.utcOffset);
    }

    if (expressionOrDate instanceof Date) {
      if (Number.isNaN(expressionOrDate.getTime())) {
        throw new CronExpressionError(
          "CronJob received an invalid Date instance.",
        );
      }
      this.targetDate = new Date(expressionOrDate.getTime());
      this.name = options.name ?? this.targetDate.toISOString();
    } else {
      this.parsed = parseCronExpression(expressionOrDate);
      this.name = options.name ?? expressionOrDate;
    }

    this.timeZone = options.timeZone;
    this.utcOffset = options.utcOffset;
    this.waitForCompletion = options.waitForCompletion ?? false;
    this.unrefTimeout = options.unrefTimeout ?? options.unref ?? true;
    this.threshold = options.threshold ?? DEFAULT_THRESHOLD_MS;
    this.initialDelay = options.initialDelay;
    this.disabled = options.disabled ?? false;
    this.onError = options.onError;
    this.onComplete = options.onComplete;

    if (options.lock && typeof options.lock === "object") {
      if (
        typeof options.lock.ttlMs !== "number" ||
        !Number.isFinite(options.lock.ttlMs) ||
        options.lock.ttlMs <= 0
      ) {
        throw new Error(
          `CronJob "${this.name}" lock.ttlMs must be a positive finite number, received ${String(options.lock.ttlMs)}.`,
        );
      }
      this.lock = { ...options.lock };
      this.lockKey = options.lock.key ?? this.name;
      this.lockMode = options.lock.mode ?? "skip";
      this.lockDriver =
        options.lockDriver ?? new InMemorySchedulerLockDriver();
      this.lockRenewIntervalMs =
        options.lock.renewIntervalMs !== undefined
          ? Math.max(5, Math.floor(options.lock.renewIntervalMs))
          : Math.max(10, Math.floor(options.lock.ttlMs / 2));
    } else {
      this.lockMode = "skip";
      this.lockRenewIntervalMs = 0;
    }
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    if (this.lock && this.lockMode === "leader") {
      this.startLeadershipLoop();
    }
    if (this.targetDate !== undefined) {
      this.scheduleOneShotDate();
      return;
    }
    this.scheduleNext(new Date());
  }

  stop(): void {
    const wasRunning = this.running;
    this.running = false;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.stopLeadershipAndRelease();
    for (const renewTimer of this.activeTickRenewTimers) {
      clearInterval(renewTimer);
    }
    this.activeTickRenewTimers.clear();
    if (wasRunning && this.onComplete) {
      this.onComplete();
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  isInFlight(): boolean {
    return this.inFlight;
  }

  /**
   * Returns `true` when this cron job currently holds the distributed leadership
   * lease (`lock.mode === "leader"`).
   */
  isLeader(): boolean {
    return this.leaderHeld;
  }

  getActiveTick(): Promise<void> | undefined {
    return this.activeTickPromise;
  }

  lastDate(): Date | undefined {
    return this.lastRunDate;
  }

  get skippedTicks(): number {
    return this.skippedTicksCount;
  }

  nextDate(from: Date = new Date()): Date {
    if (this.targetDate !== undefined) {
      return new Date(this.targetDate.getTime());
    }
    return getNextCronDate(this.parsed!, from, this.timeZone, this.utcOffset);
  }

  fireOnce(): Promise<void> {
    this.lastRunDate = new Date();
    if (this.waitForCompletion && this.inFlight) {
      this.skippedTicksCount += 1;
      return Promise.resolve();
    }

    this.inFlight = true;
    let tickPromise: Promise<void> | undefined;
    tickPromise = (async () => {
      try {
        if (!this.lock || !this.lockDriver || !this.lockKey) {
          await this.onTick();
        } else if (this.lockMode === "leader") {
          await this.executeWithLeaderLock();
        } else {
          await this.executeWithSkipLock();
        }
      } catch (error) {
        this.reportError(error);
      } finally {
        this.inFlight = false;
        if (this.activeTickPromise === tickPromise) {
          this.activeTickPromise = undefined;
        }
      }
    })();
    if (this.inFlight) {
      this.activeTickPromise = tickPromise;
    }
    return tickPromise;
  }

  private reportError(error: unknown): void {
    if (this.onError) {
      this.onError(error, this.name);
    } else {
      this.logger.error(
        `CronJob "${this.name}" failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async executeWithSkipLock(): Promise<void> {
    const driver = this.lockDriver!;
    const key = this.lockKey!;
    const ttlMs = this.lock!.ttlMs;
    const token = crypto.randomUUID();

    const acquired = await driver.acquire(key, ttlMs, token);
    if (!acquired) {
      this.skippedTicksCount += 1;
      return;
    }

    let renewTimer: ReturnType<typeof setInterval> | undefined;
    if (typeof driver.renew === "function") {
      renewTimer = setInterval(() => {
        void Promise.resolve(driver.renew!(key, ttlMs, token)).catch((err) => {
          this.reportError(err);
        });
      }, this.lockRenewIntervalMs);
      if (this.unrefTimeout) {
        renewTimer.unref?.();
      }
      this.activeTickRenewTimers.add(renewTimer);
    }

    try {
      await this.onTick();
    } finally {
      if (renewTimer !== undefined) {
        clearInterval(renewTimer);
        this.activeTickRenewTimers.delete(renewTimer);
      }
      try {
        await driver.release(key, token);
      } catch (releaseErr) {
        this.reportError(releaseErr);
      }
    }
  }

  private async executeWithLeaderLock(): Promise<void> {
    const isLeader = await this.ensureLeadership();
    if (!isLeader) {
      this.skippedTicksCount += 1;
      return;
    }
    await this.onTick();
  }

  private startLeadershipLoop(): void {
    const driver = this.lockDriver;
    const key = this.lockKey;
    const lock = this.lock;
    if (!driver || !key || !lock) {
      return;
    }

    const gen = ++this.leaderGeneration;
    this.leaderHeld = false;
    this.leaderToken = crypto.randomUUID();
    this.leaderAcquirePromise = undefined;

    void this.ensureLeadership().catch((err) => {
      this.reportError(err);
    });

    if (this.leaderRenewTimer !== undefined) {
      clearInterval(this.leaderRenewTimer);
    }

    this.leaderRenewTimer = setInterval(() => {
      if (!this.running || this.leaderGeneration !== gen) {
        return;
      }

      if (this.leaderHeld && this.leaderToken) {
        const token = this.leaderToken;
        if (typeof driver.renew === "function") {
          void Promise.resolve(driver.renew(key, lock.ttlMs, token))
            .then((renewed) => {
              if (this.leaderGeneration !== gen) {
                return;
              }
              if (!renewed) {
                this.leaderHeld = false;
              }
            })
            .catch((err) => {
              if (this.leaderGeneration === gen) {
                this.leaderHeld = false;
              }
              this.reportError(err);
            });
        }
        return;
      }

      void this.ensureLeadership().catch((err) => {
        this.reportError(err);
      });
    }, this.lockRenewIntervalMs);

    if (this.unrefTimeout) {
      this.leaderRenewTimer.unref?.();
    }
  }

  private ensureLeadership(): Promise<boolean> {
    const driver = this.lockDriver;
    const key = this.lockKey;
    const lock = this.lock;
    if (!driver || !key || !lock) {
      return Promise.resolve(false);
    }
    if (this.leaderHeld) {
      return Promise.resolve(true);
    }
    if (this.leaderAcquirePromise) {
      return this.leaderAcquirePromise;
    }

    if (!this.leaderToken) {
      this.leaderToken = crypto.randomUUID();
    }
    const token = this.leaderToken;
    const gen = this.leaderGeneration;

    const attempt = (async (): Promise<boolean> => {
      const acquired = await driver.acquire(key, lock.ttlMs, token);
      if (this.leaderGeneration !== gen) {
        if (acquired) {
          try {
            await driver.release(key, token);
          } catch (releaseErr) {
            this.reportError(releaseErr);
          }
        }
        return false;
      }
      this.leaderHeld = acquired;
      return acquired;
    })();

    this.leaderAcquirePromise = attempt;
    void attempt.finally(() => {
      if (this.leaderAcquirePromise === attempt) {
        this.leaderAcquirePromise = undefined;
      }
    });
    return attempt;
  }

  private stopLeadershipAndRelease(): void {
    this.leaderGeneration += 1;
    this.leaderAcquirePromise = undefined;
    if (this.leaderRenewTimer !== undefined) {
      clearInterval(this.leaderRenewTimer);
      this.leaderRenewTimer = undefined;
    }
    const wasLeader = this.leaderHeld;
    const token = this.leaderToken;
    this.leaderHeld = false;
    this.leaderToken = undefined;

    if (wasLeader && token && this.lockDriver && this.lockKey) {
      void Promise.resolve(this.lockDriver.release(this.lockKey, token)).catch(
        (releaseErr) => {
          this.reportError(releaseErr);
        },
      );
    }
  }

  private scheduleOneShotDate(): void {
    if (!this.running || !this.targetDate) {
      return;
    }

    const targetMs = this.targetDate.getTime();
    const diffMs = targetMs - Date.now();

    if (diffMs <= 0) {
      const missedBy = -diffMs;
      this.running = false;
      if (missedBy > this.threshold) {
        this.skippedTicksCount += 1;
        this.logger.warn(
          `CronJob "${this.name}" missed one-shot target date by ${missedBy}ms (threshold=${this.threshold}ms); skipping.`,
        );
        return;
      }
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.fireOnce();
      }, 0);
      if (this.unrefTimeout) {
        this.timer.unref?.();
      }
      return;
    }

    if (diffMs > MAX_TIMEOUT_MS) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.scheduleOneShotDate();
      }, MAX_TIMEOUT_MS);
    } else {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        if (!this.running) {
          return;
        }
        this.running = false;
        const missedBy = Date.now() - targetMs;
        if (missedBy > this.threshold) {
          this.skippedTicksCount += 1;
          this.logger.warn(
            `CronJob "${this.name}" missed one-shot target date by ${missedBy}ms (threshold=${this.threshold}ms); skipping.`,
          );
          return;
        }
        void this.fireOnce();
      }, diffMs);
    }

    if (this.unrefTimeout) {
      this.timer.unref?.();
    }
  }

  private scheduleNext(reference: Date): void {
    if (!this.running || !this.parsed) {
      return;
    }

    const next = getNextCronDate(
      this.parsed,
      reference,
      this.timeZone,
      this.utcOffset,
    );
    const delayMs = Math.max(0, next.getTime() - Date.now());

    if (delayMs > MAX_TIMEOUT_MS) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.scheduleNext(new Date(Date.now() - 1000));
      }, MAX_TIMEOUT_MS);
    } else {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        if (!this.running) {
          return;
        }
        const nowMs = Date.now();
        const missedBy = nowMs - next.getTime();
        // Schedule next tick relative to max(target slot, now) to avoid drift or catch-up bursts
        this.scheduleNext(new Date(Math.max(next.getTime(), nowMs)));
        if (missedBy > this.threshold) {
          this.skippedTicksCount += 1;
          this.logger.warn(
            `CronJob "${this.name}" (${this.parsed!.expression}) missed deadline by ${missedBy}ms (threshold=${this.threshold}ms); skipping tick.`,
          );
          return;
        }
        void this.fireOnce();
      }, delayMs);
    }

    if (this.unrefTimeout) {
      this.timer.unref?.();
    }
  }
}
