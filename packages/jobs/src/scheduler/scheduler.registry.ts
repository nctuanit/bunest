import { Injectable, Logger, type OnModuleDestroy } from "@bunest/core";
import type { CronJob } from "./cron/cron-job";
import type {
  IntervalOptions,
  TimeoutOptions,
} from "./interfaces/scheduler.interface";

export type SchedulerJobKind = "cron" | "interval" | "timeout";

/**
 * Runtime registry for managing dynamic and decorator-registered cron jobs,
 * intervals, and timeouts. Stops and clears every active timer cleanly on
 * `onModuleDestroy()` to prevent handle leaks.
 */
@Injectable()
export class SchedulerRegistry implements OnModuleDestroy {
  private readonly cronJobs = new Map<string, CronJob>();
  private readonly intervals = new Map<
    string,
    ReturnType<typeof setInterval>
  >();
  private readonly timeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly logger = new Logger("SchedulerRegistry");

  doesExist(kind: SchedulerJobKind, name: string): boolean {
    switch (kind) {
      case "cron":
        return this.cronJobs.has(name);
      case "interval":
        return this.intervals.has(name);
      case "timeout":
        return this.timeouts.has(name);
    }
  }

  // --- Cron Jobs ---

  addCronJob(name: string, job: CronJob): void {
    if (this.cronJobs.has(name)) {
      throw new Error(`Cron job with name "${name}" already exists.`);
    }
    this.cronJobs.set(name, job);
  }

  getCronJob(name: string): CronJob {
    const job = this.cronJobs.get(name);
    if (!job) {
      throw new Error(`No cron job found with name "${name}".`);
    }
    return job;
  }

  getCronJobs(): Map<string, CronJob> {
    return new Map(this.cronJobs);
  }

  deleteCronJob(name: string): void {
    const job = this.getCronJob(name);
    job.stop();
    this.cronJobs.delete(name);
  }

  // --- Intervals ---

  addInterval(name: string, intervalId: ReturnType<typeof setInterval>): void {
    if (this.intervals.has(name)) {
      throw new Error(`Interval with name "${name}" already exists.`);
    }
    intervalId.unref?.();
    this.intervals.set(name, intervalId);
  }

  scheduleInterval(
    name: string,
    timeoutMs: number,
    callback: () => unknown | Promise<unknown>,
    options: Omit<IntervalOptions, "name"> = {},
  ): ReturnType<typeof setInterval> {
    if (this.intervals.has(name)) {
      throw new Error(`Interval with name "${name}" already exists.`);
    }

    const waitForCompletion = options.waitForCompletion ?? false;
    let inFlight = false;

    const id = setInterval(() => {
      if (waitForCompletion && inFlight) {
        return;
      }
      inFlight = true;
      Promise.resolve()
        .then(() => callback())
        .catch((err) => {
          if (options.onError) {
            options.onError(err, name);
          } else {
            this.logger.error(
              `Interval "${name}" failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        })
        .finally(() => {
          inFlight = false;
        });
    }, timeoutMs);

    if (options.unref !== false) {
      id.unref?.();
    }
    this.intervals.set(name, id);
    return id;
  }

  getInterval(name: string): ReturnType<typeof setInterval> {
    const id = this.intervals.get(name);
    if (id === undefined) {
      throw new Error(`No interval found with name "${name}".`);
    }
    return id;
  }

  getIntervals(): string[] {
    return [...this.intervals.keys()];
  }

  deleteInterval(name: string): void {
    const id = this.getInterval(name);
    clearInterval(id);
    this.intervals.delete(name);
  }

  // --- Timeouts ---

  addTimeout(name: string, timeoutId: ReturnType<typeof setTimeout>): void {
    if (this.timeouts.has(name)) {
      throw new Error(`Timeout with name "${name}" already exists.`);
    }
    timeoutId.unref?.();
    this.timeouts.set(name, timeoutId);
  }

  scheduleTimeout(
    name: string,
    timeoutMs: number,
    callback: () => unknown | Promise<unknown>,
    options: Omit<TimeoutOptions, "name"> = {},
  ): ReturnType<typeof setTimeout> {
    if (this.timeouts.has(name)) {
      throw new Error(`Timeout with name "${name}" already exists.`);
    }

    const id = setTimeout(() => {
      Promise.resolve()
        .then(() => callback())
        .catch((err) => {
          if (options.onError) {
            options.onError(err, name);
          } else {
            this.logger.error(
              `Timeout "${name}" failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        });
    }, timeoutMs);

    if (options.unref !== false) {
      id.unref?.();
    }
    this.timeouts.set(name, id);
    return id;
  }

  getTimeout(name: string): ReturnType<typeof setTimeout> {
    const id = this.timeouts.get(name);
    if (id === undefined) {
      throw new Error(`No timeout found with name "${name}".`);
    }
    return id;
  }

  getTimeouts(): string[] {
    return [...this.timeouts.keys()];
  }

  deleteTimeout(name: string): void {
    const id = this.getTimeout(name);
    clearTimeout(id);
    this.timeouts.delete(name);
  }

  /**
   * Stops and clears every registered cron job, interval, and timeout cleanly.
   */
  stopAll(): void {
    for (const job of this.cronJobs.values()) {
      job.stop();
    }
    this.cronJobs.clear();

    for (const id of this.intervals.values()) {
      clearInterval(id);
    }
    this.intervals.clear();

    for (const id of this.timeouts.values()) {
      clearTimeout(id);
    }
    this.timeouts.clear();
  }

  onModuleDestroy(): void {
    this.stopAll();
  }
}
