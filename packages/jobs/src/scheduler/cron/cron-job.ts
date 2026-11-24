import { Logger } from "@bunest/core";
import type {
  CronOptions,
  CronTime,
  ParsedCronExpression,
} from "../interfaces/scheduler.interface";
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
 * protection (`waitForCompletion`), IANA timezones, fixed `utcOffset`,
 * `Date` one-shot schedules, missed-deadline `threshold`, `unrefTimeout`,
 * `initialDelay`, and clean teardown.
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
  private readonly onError?: (error: unknown, jobName: string) => void;
  private readonly logger = new Logger("CronJob");

  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private inFlight = false;
  private lastRunDate?: Date;
  private skippedTicksCount = 0;

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
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    if (this.targetDate !== undefined) {
      this.scheduleOneShotDate();
      return;
    }
    this.scheduleNext(new Date());
  }

  stop(): void {
    this.running = false;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  isInFlight(): boolean {
    return this.inFlight;
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

  async fireOnce(): Promise<void> {
    if (this.waitForCompletion && this.inFlight) {
      this.skippedTicksCount += 1;
      return;
    }

    this.inFlight = true;
    this.lastRunDate = new Date();
    try {
      await this.onTick();
    } catch (error) {
      if (this.onError) {
        this.onError(error, this.name);
      } else {
        this.logger.error(
          `CronJob "${this.name}" failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      this.inFlight = false;
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
