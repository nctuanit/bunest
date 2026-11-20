import {
  MemoryQueueDriver,
  Queue as CoreQueue,
  RedisQueueDriver,
  type BackoffOptions,
  type Job as CoreJob,
  type JobOptions as CoreJobOptions,
  type QueueDriver,
  type RedisQueueClientLike,
} from "@bunest/queues";
import { BullQueueEvents } from "../enums/bull-queue-events.enum";
import { BullQueueGlobalEvents } from "../enums/bull-queue-global-events.enum";
import { BullJob, type BullJobHost } from "./bull-job";
import type {
  BullJobOptions,
  BullJobStatus,
  BullQueueOptions,
  BullQueueProcessorCallback,
  DoneCallback,
  JobCounts,
  JobStatusClean,
} from "./bull-queue.types";

const DEFAULT_JOB_NAME = "__default__";

type EventListener = (...args: any[]) => any;

function mapBackoff(
  backoff: BullJobOptions["backoff"],
): BackoffOptions | undefined {
  if (typeof backoff === "number") {
    return { type: "fixed", delayMs: backoff };
  }
  if (backoff && typeof backoff === "object") {
    return {
      type: backoff.type === "exponential" ? "exponential" : "fixed",
      delayMs: backoff.delay ?? 0,
    };
  }
  return undefined;
}

function isRedisQueueClientLike(value: unknown): value is RedisQueueClientLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as RedisQueueClientLike).hset === "function" &&
    typeof (value as RedisQueueClientLike).hget === "function" &&
    typeof (value as RedisQueueClientLike).zadd === "function"
  );
}

/**
 * Classic Bull v4-compatible `Queue` facade backed natively by `@bunest/queues`
 * (`MemoryQueueDriver` or `RedisQueueDriver`) with full local and `global:*` event parity.
 */
export class BullQueue<T = any> implements BullJobHost {
  public readonly name: string;
  public readonly options: BullQueueOptions;

  private readonly coreQueue: CoreQueue<T, any>;
  private readonly driver: QueueDriver;
  private readonly ownsDriver: boolean;
  private readonly jobs = new Map<string, BullJob<T>>();
  private readonly jobLogs = new Map<string, string[]>();
  private readonly finishedWaiters = new Map<
    string,
    Array<{ resolve: (val: any) => void; reject: (err: any) => void }>
  >();
  private readonly listeners = new Map<string, Set<EventListener>>();
  private readonly unbindCoreEvents: Array<() => void> = [];
  private closed = false;

  constructor(name: string, options: BullQueueOptions = {}) {
    this.name = name || "default";
    this.options = options;

    if (options.driver) {
      this.driver = options.driver;
      this.ownsDriver = false;
    } else if (typeof options.createClient === "function") {
      const client = options.createClient(
        "client",
        typeof options.redis === "object" ? options.redis : undefined,
      );
      if (isRedisQueueClientLike(client)) {
        this.driver = new RedisQueueDriver(client, {
          prefix: options.prefix ?? "bull",
          lockDurationMs: options.settings?.lockDuration,
          stalledIntervalMs: options.settings?.stalledInterval,
          maxStalledCount: options.settings?.maxStalledCount,
        });
        this.ownsDriver = true;
      } else {
        this.driver = new MemoryQueueDriver();
        this.ownsDriver = true;
      }
    } else {
      this.driver = new MemoryQueueDriver();
      this.ownsDriver = true;
    }

    const defOpts = options.defaultJobOptions;
    this.coreQueue = new CoreQueue<T, any>({
      name: this.name,
      driver: this.driver,
      defaultJobOptions: defOpts
        ? {
            attempts: defOpts.attempts,
            backoff: mapBackoff(defOpts.backoff),
            timeoutMs: defOpts.timeout,
            delay: defOpts.delay,
            priority: defOpts.priority,
            removeOnComplete: defOpts.removeOnComplete,
            removeOnFail: defOpts.removeOnFail,
          }
        : undefined,
    });

    this.bindCoreQueueEvents();
  }

  private bindCoreQueueEvents(): void {
    this.unbindCoreEvents.push(
      this.coreQueue.on("active", (coreJob) => {
        const bullJob = this.ensureBullJob(coreJob, "active");
        this.emit(BullQueueEvents.ACTIVE, bullJob);
        this.emit(BullQueueGlobalEvents.ACTIVE, String(bullJob.id));
      }),
    );

    this.unbindCoreEvents.push(
      this.coreQueue.on("completed", (coreJob, result) => {
        const bullJob = this.ensureBullJob(coreJob, "completed");
        bullJob.returnvalue = result;
        this.emit(BullQueueEvents.COMPLETED, bullJob, result);
        this.emit(BullQueueGlobalEvents.COMPLETED, String(bullJob.id), result);
        this.settleFinishedWaiters(String(bullJob.id), true, result);
      }),
    );

    this.unbindCoreEvents.push(
      this.coreQueue.on("failed", (coreJob, err) => {
        const bullJob = this.ensureBullJob(coreJob, "failed");
        const error =
          err instanceof Error
            ? err
            : new Error(coreJob.failedReason ?? String(err ?? "Job failed"));
        this.emit(BullQueueEvents.FAILED, bullJob, error);
        this.emit(
          BullQueueGlobalEvents.FAILED,
          String(bullJob.id),
          error.message,
        );
        // Settle finished() promise if job reached terminal failed state
        if (
          coreJob.status === "failed" ||
          coreJob.status === "dead-letter" ||
          coreJob.attemptsMade >= coreJob.maxAttempts
        ) {
          this.settleFinishedWaiters(String(bullJob.id), false, error);
        }
      }),
    );

    this.unbindCoreEvents.push(
      this.coreQueue.on("stalled", (coreJob) => {
        const bullJob = this.ensureBullJob(coreJob);
        this.emit(BullQueueEvents.STALLED, bullJob);
        this.emit(BullQueueGlobalEvents.STALLED, String(bullJob.id));
      }),
    );

    this.unbindCoreEvents.push(
      this.coreQueue.on("paused", () => {
        this.emit(BullQueueEvents.PAUSED);
        this.emit(BullQueueGlobalEvents.PAUSED);
      }),
    );

    this.unbindCoreEvents.push(
      this.coreQueue.on("resumed", () => {
        this.emit(BullQueueEvents.RESUMED);
        this.emit(BullQueueGlobalEvents.RESUMED);
      }),
    );

    this.unbindCoreEvents.push(
      this.coreQueue.on("drained", () => {
        this.emit(BullQueueEvents.DRAINED);
        this.emit(BullQueueGlobalEvents.DRAINED);
      }),
    );
  }

  private ensureBullJob(
    coreJob: CoreJob<T, any>,
    overrideState?: BullJobStatus,
    opts?: BullJobOptions,
  ): BullJob<T> {
    const key = String(coreJob.id);
    let bullJob = this.jobs.get(key);
    if (!bullJob) {
      bullJob = new BullJob<T>(this, coreJob, opts ?? {});
      this.jobs.set(key, bullJob);
    } else {
      bullJob._syncFromCore(coreJob, overrideState);
    }
    return bullJob;
  }

  private settleFinishedWaiters(
    jobId: string,
    ok: boolean,
    valueOrError: any,
  ): void {
    const waiters = this.finishedWaiters.get(jobId);
    if (!waiters || waiters.length === 0) return;
    this.finishedWaiters.delete(jobId);
    for (const w of waiters) {
      if (ok) w.resolve(valueOrError);
      else w.reject(valueOrError);
    }
  }

  // --- EventEmitter API ---

  on(event: string, listener: EventListener): this {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return this;
  }

  addListener(event: string, listener: EventListener): this {
    return this.on(event, listener);
  }

  once(event: string, listener: EventListener): this {
    const wrapper: EventListener = (...args: any[]) => {
      this.off(event, wrapper);
      return listener(...args);
    };
    return this.on(event, wrapper);
  }

  off(event: string, listener: EventListener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  removeListener(event: string, listener: EventListener): this {
    return this.off(event, listener);
  }

  removeAllListeners(event?: string): this {
    if (event !== undefined) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
    return this;
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  emit(event: string, ...args: any[]): boolean {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) {
      return false;
    }
    for (const listener of [...set]) {
      try {
        const res = listener(...args);
        if (res && typeof res.catch === "function") {
          void res.catch((err: unknown) => {
            if (event !== BullQueueEvents.ERROR) {
              this.emit(
                BullQueueEvents.ERROR,
                err instanceof Error ? err : new Error(String(err)),
              );
            }
          });
        }
      } catch (err) {
        if (event !== BullQueueEvents.ERROR) {
          this.emit(
            BullQueueEvents.ERROR,
            err instanceof Error ? err : new Error(String(err)),
          );
        }
      }
    }
    return true;
  }

  // --- BullJobHost internal hooks ---

  _emitJobProgress(job: BullJob<any>, progress: any): void {
    this.emit(BullQueueEvents.PROGRESS, job, progress);
    this.emit(BullQueueGlobalEvents.PROGRESS, String(job.id), progress);
  }

  async _removeJob(job: BullJob<any>): Promise<void> {
    const id = String(job.id);
    this.jobs.delete(id);
    this.jobLogs.delete(id);
    this.emit(BullQueueEvents.REMOVED, job);
    this.emit(BullQueueGlobalEvents.REMOVED, id);
  }

  async _retryJob(job: BullJob<any>): Promise<void> {
    const retried = await this.coreQueue.retryDeadLetter(String(job.id));
    if (retried) {
      job._syncFromCore(retried, "waiting");
    }
  }

  async _promoteJob(job: BullJob<any>): Promise<void> {
    job._setState("waiting");
  }

  _addJobLog(jobId: string, row: string): number {
    let logs = this.jobLogs.get(jobId);
    if (!logs) {
      logs = [];
      this.jobLogs.set(jobId, logs);
    }
    logs.push(row);
    return logs.length;
  }

  _waitForJobFinished(job: BullJob<any>): Promise<any> {
    return new Promise((resolve, reject) => {
      void job.getState().then((state) => {
        if (state === "completed") {
          resolve(job.returnvalue);
          return;
        }
        if (state === "failed") {
          reject(new Error(job.failedReason ?? "Job failed"));
          return;
        }
        const id = String(job.id);
        let list = this.finishedWaiters.get(id);
        if (!list) {
          list = [];
          this.finishedWaiters.set(id, list);
        }
        list.push({ resolve, reject });
      });
    });
  }

  _isQueuePaused(): boolean {
    return this.coreQueue.isPaused;
  }

  // --- Public Bull v4 Queue API ---

  async add(data: T, opts?: BullJobOptions): Promise<BullJob<T>>;
  async add(name: string, data: T, opts?: BullJobOptions): Promise<BullJob<T>>;
  async add(
    nameOrData: string | T,
    dataOrOpts?: T | BullJobOptions,
    maybeOpts?: BullJobOptions,
  ): Promise<BullJob<T>> {
    let jobName: string;
    let data: T;
    let opts: BullJobOptions | undefined;

    if (typeof nameOrData === "string") {
      jobName = nameOrData;
      data = dataOrOpts as T;
      opts = maybeOpts;
    } else {
      jobName = DEFAULT_JOB_NAME;
      data = nameOrData;
      opts = dataOrOpts as BullJobOptions | undefined;
    }

    const mergedOpts: BullJobOptions = {
      ...this.options.defaultJobOptions,
      ...opts,
    };

    const coreOpts: CoreJobOptions = {
      jobId:
        mergedOpts.jobId !== undefined ? String(mergedOpts.jobId) : undefined,
      priority: mergedOpts.priority,
      delayMs: mergedOpts.delay,
      attempts: mergedOpts.attempts,
      backoff: mapBackoff(mergedOpts.backoff),
      timeoutMs: mergedOpts.timeout,
      removeOnComplete: mergedOpts.removeOnComplete,
      removeOnFail: mergedOpts.removeOnFail,
    };

    const coreJob = await this.coreQueue.add(jobName, data, coreOpts);
    const bullJob = this.ensureBullJob(coreJob, undefined, mergedOpts);

    if (coreJob.status === "waiting") {
      this.emit(BullQueueEvents.WAITING, String(bullJob.id));
      this.emit(BullQueueGlobalEvents.WAITING, String(bullJob.id));
    }

    return bullJob;
  }

  async addBulk(
    jobs: Array<{ name?: string; data: T; opts?: BullJobOptions }>,
  ): Promise<BullJob<T>[]> {
    const out: BullJob<T>[] = [];
    for (const item of jobs) {
      if (item.name !== undefined) {
        out.push(await this.add(item.name, item.data, item.opts));
      } else {
        out.push(await this.add(item.data, item.opts));
      }
    }
    return out;
  }

  process(callback: BullQueueProcessorCallback<T> | string): void;
  process(
    concurrency: number,
    callback: BullQueueProcessorCallback<T> | string,
  ): void;
  process(
    name: string,
    callback: BullQueueProcessorCallback<T> | string,
  ): void;
  process(
    name: string,
    concurrency: number,
    callback: BullQueueProcessorCallback<T> | string,
  ): void;
  process(...args: any[]): void {
    let jobName: string | undefined;
    let concurrency: number | undefined;
    let handlerOrPath: BullQueueProcessorCallback<T> | string;

    if (args.length === 1) {
      handlerOrPath = args[0];
    } else if (args.length === 2) {
      if (typeof args[0] === "number") {
        concurrency = args[0];
        handlerOrPath = args[1];
      } else {
        jobName = args[0];
        handlerOrPath = args[1];
      }
    } else {
      jobName = args[0];
      concurrency = args[1];
      handlerOrPath = args[2];
    }

    if (typeof concurrency === "number" && concurrency > 0) {
      this.coreQueue.setConcurrency(concurrency);
    }

    let resolvedCallbackPromise: Promise<BullQueueProcessorCallback<T>> | null =
      null;
    const getCallback = async (): Promise<BullQueueProcessorCallback<T>> => {
      if (typeof handlerOrPath === "function") {
        return handlerOrPath;
      }
      if (!resolvedCallbackPromise) {
        resolvedCallbackPromise = import(handlerOrPath).then((mod) => {
          const fn = mod.default ?? mod;
          if (typeof fn !== "function") {
            throw new Error(
              `Separate processor module "${handlerOrPath}" does not export a default function.`,
            );
          }
          return fn as BullQueueProcessorCallback<T>;
        });
      }
      return resolvedCallbackPromise;
    };

    const wrappedHandler = async (coreJob: CoreJob<T, any>): Promise<any> => {
      const bullJob = this.ensureBullJob(coreJob, "active");
      const fn = await getCallback();

      // Support Node-style `(job, done) => void` callbacks as well as async `(job) => Promise<any>`
      if (fn.length >= 2) {
        return await new Promise<any>((resolve, reject) => {
          let settled = false;
          const done: DoneCallback = (err, val) => {
            if (settled) return;
            settled = true;
            if (err) reject(err);
            else resolve(val);
          };
          try {
            const ret = fn(bullJob, done);
            if (ret && typeof (ret as Promise<any>).then === "function") {
              (ret as Promise<any>).then(
                (val) => {
                  if (!settled) {
                    settled = true;
                    resolve(val);
                  }
                },
                (err) => {
                  if (!settled) {
                    settled = true;
                    reject(err);
                  }
                },
              );
            }
          } catch (err) {
            if (!settled) {
              settled = true;
              reject(err);
            }
          }
        });
      }

      return await fn(bullJob);
    };

    if (jobName !== undefined && jobName !== "*") {
      this.coreQueue.process(jobName, wrappedHandler);
    } else {
      this.coreQueue.process(wrappedHandler);
    }
  }

  async pause(_isLocal?: boolean, _doNotWaitActive?: boolean): Promise<void> {
    this.coreQueue.pause();
  }

  async resume(_isLocal?: boolean): Promise<void> {
    this.coreQueue.resume();
  }

  async isPaused(_isLocal?: boolean): Promise<boolean> {
    return this.coreQueue.isPaused;
  }

  async getJob(jobId: string | number): Promise<BullJob<T> | null> {
    const id = String(jobId);
    const existing = this.jobs.get(id);
    const coreJob = await this.coreQueue.getJob(id);
    if (coreJob) {
      return this.ensureBullJob(coreJob);
    }
    return existing ?? null;
  }

  async getJobs(
    types: BullJobStatus[],
    start = 0,
    end = -1,
    asc = false,
  ): Promise<BullJob<T>[]> {
    const typeSet = new Set(types);
    const matched: BullJob<T>[] = [];
    for (const job of this.jobs.values()) {
      const state = await job.getState();
      if (typeSet.has(state)) {
        matched.push(job);
      }
    }
    if (!asc) {
      matched.reverse();
    }
    const sliceEnd = end < 0 ? matched.length : end + 1;
    return matched.slice(start, sliceEnd);
  }

  async getWaiting(start = 0, end = -1): Promise<BullJob<T>[]> {
    return this.getJobs(["waiting"], start, end);
  }

  async getActive(start = 0, end = -1): Promise<BullJob<T>[]> {
    return this.getJobs(["active"], start, end);
  }

  async getDelayed(start = 0, end = -1): Promise<BullJob<T>[]> {
    return this.getJobs(["delayed"], start, end);
  }

  async getCompleted(start = 0, end = -1): Promise<BullJob<T>[]> {
    return this.getJobs(["completed"], start, end);
  }

  async getFailed(start = 0, end = -1): Promise<BullJob<T>[]> {
    return this.getJobs(["failed"], start, end);
  }

  async getJobCounts(): Promise<JobCounts> {
    const counts = await this.coreQueue.getCounts();
    const paused = this.coreQueue.isPaused ? counts.waiting : 0;
    return {
      waiting: this.coreQueue.isPaused ? 0 : counts.waiting,
      active: counts.active,
      completed: counts.completed,
      failed: counts.failed,
      delayed: counts.delayed,
      paused,
    };
  }

  async count(): Promise<number> {
    const c = await this.getJobCounts();
    return c.waiting + c.delayed + (c.paused ?? 0);
  }

  async getWaitingCount(): Promise<number> {
    return (await this.getJobCounts()).waiting;
  }

  async getActiveCount(): Promise<number> {
    return (await this.getJobCounts()).active;
  }

  async getDelayedCount(): Promise<number> {
    return (await this.getJobCounts()).delayed;
  }

  async getCompletedCount(): Promise<number> {
    return (await this.getJobCounts()).completed;
  }

  async getFailedCount(): Promise<number> {
    return (await this.getJobCounts()).failed;
  }

  async getPausedCount(): Promise<number> {
    return (await this.getJobCounts()).paused ?? 0;
  }

  async getJobLogs(
    jobId: string | number,
    start = 0,
    end = -1,
  ): Promise<{ logs: string[]; count: number }> {
    const all = this.jobLogs.get(String(jobId)) ?? [];
    const sliceEnd = end < 0 ? all.length : end + 1;
    return {
      logs: all.slice(start, sliceEnd),
      count: all.length,
    };
  }

  async clean(
    grace: number,
    status: JobStatusClean = "completed",
    limit?: number,
  ): Promise<BullJob<T>[]> {
    const targetState: BullJobStatus = status === "wait" ? "waiting" : status;
    const cutoff = Date.now() - Math.max(0, grace);
    const cleaned: BullJob<T>[] = [];

    for (const [id, job] of [...this.jobs.entries()]) {
      if (limit !== undefined && cleaned.length >= limit) break;
      const state = await job.getState();
      const refTime = job.finishedOn ?? job.processedOn ?? job.timestamp;
      if (state === targetState && refTime <= cutoff) {
        this.jobs.delete(id);
        this.jobLogs.delete(id);
        cleaned.push(job);
      }
    }

    this.emit(BullQueueEvents.CLEANED, cleaned, status);
    this.emit(
      BullQueueGlobalEvents.CLEANED,
      cleaned.map((j) => String(j.id)),
      status,
    );
    return cleaned;
  }

  async empty(): Promise<void> {
    for (const [id, job] of [...this.jobs.entries()]) {
      const state = await job.getState();
      if (state === "waiting" || state === "paused") {
        this.jobs.delete(id);
      }
    }
  }

  async obliterate(opts?: { force?: boolean }): Promise<void> {
    if (!opts?.force && !this.coreQueue.isPaused) {
      throw new Error("Cannot obliterate non-paused queue without `{ force: true }`.");
    }
    this.jobs.clear();
    this.jobLogs.clear();
  }

  async isReady(): Promise<this> {
    return this;
  }

  async close(doNotWaitJobs = false): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    await this.coreQueue.close(doNotWaitJobs ? 0 : undefined);

    for (const unbind of this.unbindCoreEvents.splice(0)) {
      unbind();
    }

    if (this.ownsDriver) {
      await this.driver.close();
    }
  }

  onApplicationShutdown(): Promise<void> {
    return this.close();
  }
}
