import { calculateBackoffDelay } from "./backoff";
import { MemoryQueueDriver } from "./drivers/memory.driver";
import type {
  BullMQQueueEventName,
  BulkJobInput,
  DefaultJobOptions,
  Job,
  JobHandler,
  JobOptions,
  QueueConfig,
  QueueCounts,
  QueueDriver,
  QueueEventListener,
} from "./interfaces";

export class JobTimeoutError extends Error {
  constructor(
    public readonly jobId: string,
    public readonly timeoutMs: number,
  ) {
    super(`Job "${jobId}" timed out after ${timeoutMs}ms`);
    this.name = "JobTimeoutError";
  }
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
}

/**
 * Managed job queue supporting priority/FIFO scheduling, delayed jobs, idempotency
 * deduplication, concurrency limiting, retries with fixed/exponential backoff,
 * per-job timeouts, Dead-Letter Queue (DLQ), and graceful shutdown draining.
 */
export class Queue<TData = unknown, TResult = unknown> {
  public readonly name: string;

  private readonly driver: QueueDriver;
  private readonly defaultJobOptions: DefaultJobOptions;
  private readonly shutdownTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly idlePollIntervalMs: number;

  private concurrency: number;
  private readonly handlers = new Map<string, JobHandler<TData, TResult>>();
  private defaultHandler?: JobHandler<TData, TResult>;
  private readonly listeners = new Map<
    string,
    Set<QueueEventListener<TData, TResult>>
  >();

  private paused = false;
  private closed = false;
  private inFlightCount = 0;
  private pumping = false;
  private pumpAgain = false;
  private pumpErrorCount = 0;
  private jobCounter = 0;

  private delayedTimer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private pumpRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly activeJobTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly activeLeaseTimers = new Set<
    ReturnType<typeof setInterval>
  >();
  private readonly drainWaiters = new Set<() => void>();
  private unbindDriverStalled: (() => void) | undefined;

  constructor(config: QueueConfig) {
    this.name = config.name;
    this.driver = config.driver ?? new MemoryQueueDriver();
    this.concurrency = Math.max(1, Math.floor(config.concurrency ?? 1));
    this.defaultJobOptions = config.defaultJobOptions ?? {};
    this.shutdownTimeoutMs = Math.max(
      0,
      Math.floor(config.shutdownTimeoutMs ?? 5000),
    );
    if (config.pollIntervalMs !== undefined) {
      if (config.pollIntervalMs <= 0) {
        this.idlePollIntervalMs = 0;
        this.pollIntervalMs = 50;
      } else {
        const clamped = Math.max(5, Math.floor(config.pollIntervalMs));
        this.idlePollIntervalMs = clamped;
        this.pollIntervalMs = clamped;
      }
    } else if (this.driver instanceof MemoryQueueDriver) {
      this.idlePollIntervalMs = 0;
      this.pollIntervalMs = 50;
    } else {
      this.idlePollIntervalMs = 250;
      this.pollIntervalMs = 250;
    }

    if (typeof this.driver.onStalled === "function") {
      this.unbindDriverStalled = this.driver.onStalled(this.name, (result) => {
        for (const job of result.reclaimed) {
          void this.emitEvent("stalled", job as Job<TData, TResult>);
        }
        for (const job of result.deadLettered) {
          void this.emitEvent("stalled", job as Job<TData, TResult>);
          void this.emitEvent(
            "dead-letter",
            job as Job<TData, TResult>,
            new Error(job.failedReason ?? "Job exceeded maxStalledCount"),
          );
        }
        if (result.reclaimed.length > 0 && !this.closed && !this.paused) {
          this.triggerPump();
        }
      });
    }
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get activeCount(): number {
    return this.inFlightCount;
  }

  setConcurrency(concurrency: number): void {
    this.concurrency = Math.max(1, Math.floor(concurrency));
    this.triggerPump();
  }

  /**
   * Registers a job handler for a specific job name (or the default catch-all handler
   * when `jobName` is omitted or `"*"`).
   */
  process(handler: JobHandler<TData, TResult>): void;
  process(jobName: string, handler: JobHandler<TData, TResult>): void;
  process(
    jobNameOrHandler: string | JobHandler<TData, TResult>,
    maybeHandler?: JobHandler<TData, TResult>,
  ): void {
    if (typeof jobNameOrHandler === "function") {
      this.defaultHandler = jobNameOrHandler;
    } else if (jobNameOrHandler === "*") {
      if (!maybeHandler) {
        throw new Error(
          `Queue "${this.name}" process("*") requires a handler.`,
        );
      }
      this.defaultHandler = maybeHandler;
    } else {
      if (!maybeHandler) {
        throw new Error(
          `Queue "${this.name}" process("${jobNameOrHandler}") requires a handler.`,
        );
      }
      this.handlers.set(jobNameOrHandler, maybeHandler);
    }

    this.triggerPump();
  }

  on(
    event: BullMQQueueEventName,
    listener: QueueEventListener<TData, TResult>,
  ): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => this.off(event, listener);
  }

  off(
    event: BullMQQueueEventName,
    listener: QueueEventListener<TData, TResult>,
  ): void {
    this.listeners.get(event)?.delete(listener);
  }

  /**
   * Enqueues a job. If `options.idempotencyKey` (or `options.jobId`) matches an
   * existing job, returns that existing job without duplicating execution.
   */
  async add(
    name: string,
    data: TData,
    options?: JobOptions,
  ): Promise<Job<TData, TResult>> {
    if (this.closed) {
      throw new Error(`Queue "${this.name}" is closed and cannot accept jobs.`);
    }

    const now = Date.now();
    const delayMs = Math.max(
      0,
      options?.delayMs ?? options?.delay ?? this.defaultJobOptions.delay ?? 0,
    );
    const maxAttempts = Math.max(
      1,
      Math.floor(options?.attempts ?? this.defaultJobOptions.attempts ?? 1),
    );

    const childrenValues =
      options?.childrenValues !== undefined
        ? { ...options.childrenValues }
        : undefined;

    const job: Job<TData, TResult> = {
      id:
        options?.jobId ??
        `${this.name}:${now}:${++this.jobCounter}:${crypto.randomUUID().slice(0, 8)}`,
      queueName: this.name,
      name,
      data,
      priority: options?.priority ?? this.defaultJobOptions.priority ?? 0,
      idempotencyKey: options?.idempotencyKey,
      maxAttempts,
      attemptsMade: 0,
      status: delayMs > 0 ? "delayed" : "waiting",
      backoff: options?.backoff ?? this.defaultJobOptions.backoff,
      timeoutMs: options?.timeoutMs ?? this.defaultJobOptions.timeoutMs,
      removeOnComplete: Boolean(
        options?.removeOnComplete ??
        this.defaultJobOptions.removeOnComplete ??
        false,
      ),
      createdAt: now,
      processAfter: now + delayMs,
      stacktrace: [],
      ...(childrenValues !== undefined
        ? {
            childrenValues,
            getChildrenValues: async <T = unknown>() =>
              ({ ...childrenValues }) as Record<string, T>,
          }
        : {}),
    };

    const stored = await this.driver.enqueue<TData, TResult>(this.name, job);
    await this.emitEvent("added", stored);
    if (delayMs > 0) {
      await this.emitEvent("delayed", stored, stored.processAfter);
    }
    this.triggerPump();
    return stored;
  }

  async addBulk(
    jobs: readonly BulkJobInput<TData>[],
  ): Promise<Job<TData, TResult>[]> {
    const results: Job<TData, TResult>[] = [];
    for (const item of jobs) {
      results.push(await this.add(item.name, item.data, item.options));
    }
    return results;
  }

  async getJob(id: string): Promise<Job<TData, TResult> | null> {
    return this.driver.getJob<TData, TResult>(this.name, id);
  }

  async getCounts(): Promise<QueueCounts> {
    return this.driver.getCounts(this.name);
  }

  async getDeadLetterJobs(): Promise<Job<TData, TResult>[]> {
    return this.driver.getDeadLetterJobs<TData, TResult>(this.name);
  }

  async retryDeadLetter(id: string): Promise<Job<TData, TResult> | null> {
    const job = await this.driver.retryDeadLetterJob<TData, TResult>(
      this.name,
      id,
    );
    if (job) {
      this.triggerPump();
    }
    return job;
  }

  pause(): void {
    this.paused = true;
    this.clearDelayedTimer();
    this.clearPollTimer();
    this.clearPumpRetryTimer();
    void this.emitLifecycleEvent("paused");
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    void this.emitLifecycleEvent("resumed");
    this.triggerPump();
  }

  /**
   * Waits for all currently in-flight active jobs to finish (optionally bounded by `timeoutMs`).
   */
  async drain(timeoutMs?: number): Promise<void> {
    if (this.inFlightCount === 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;

      const done = () => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        this.drainWaiters.delete(done);
        resolve();
      };

      this.drainWaiters.add(done);

      if (timeoutMs !== undefined && timeoutMs >= 0) {
        timer = setTimeout(done, timeoutMs);
        unrefTimer(timer);
      }
    });
  }

  private workersClosing = false;

  /**
   * Stops dequeuing new jobs and drains in-flight jobs without marking the
   * queue closed, so active jobs can still enqueue child jobs onto other queues
   * during graceful application shutdown.
   */
  async closeWorkers(timeoutMs: number = this.shutdownTimeoutMs): Promise<void> {
    if (this.closed || this.workersClosing) {
      return;
    }
    this.workersClosing = true;
    this.clearDelayedTimer();
    this.clearPollTimer();
    this.clearPumpRetryTimer();
    await this.drain(timeoutMs);
  }

  /**
   * Stops dequeuing new jobs, clears delayed timers, and drains in-flight jobs up to
   * `timeoutMs` (defaults to `shutdownTimeoutMs`). Idempotent.
   */
  async close(timeoutMs: number = this.shutdownTimeoutMs): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.workersClosing = true;
    this.clearDelayedTimer();
    this.clearPollTimer();
    this.clearPumpRetryTimer();
    this.unbindDriverStalled?.();
    this.unbindDriverStalled = undefined;

    await this.drain(timeoutMs);

    for (const timer of this.activeJobTimers) {
      clearTimeout(timer);
    }
    this.activeJobTimers.clear();

    for (const leaseTimer of this.activeLeaseTimers) {
      clearInterval(leaseTimer);
    }
    this.activeLeaseTimers.clear();

    await this.emitLifecycleEvent("closed");
  }

  private hasHandlers(): boolean {
    return this.defaultHandler !== undefined || this.handlers.size > 0;
  }

  private resolveHandler(
    jobName: string,
  ): JobHandler<TData, TResult> | undefined {
    return this.handlers.get(jobName) ?? this.defaultHandler;
  }

  private triggerPump(): void {
    if (this.closed || this.workersClosing || this.paused || !this.hasHandlers()) {
      return;
    }
    this.clearPollTimer();
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    void this.pumpLoop();
  }

  private async pumpLoop(): Promise<void> {
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;

        while (
          !this.closed &&
          !this.workersClosing &&
          !this.paused &&
          this.hasHandlers() &&
          this.inFlightCount < this.concurrency
        ) {
          this.inFlightCount++;
          let job: Job<TData, TResult> | null = null;
          try {
            job = await this.driver.dequeue<TData, TResult>(this.name);
            this.pumpErrorCount = 0;
            this.clearPumpRetryTimer();
          } catch (rawErr) {
            this.inFlightCount--;
            this.notifyDrainIfIdle();
            const err =
              rawErr instanceof Error ? rawErr : new Error(String(rawErr));
            this.pumpErrorCount++;
            void this.emitEvent("error", this.createLifecycleJob(), err);
            this.schedulePumpRetry();
            break;
          }

          if (!job) {
            this.inFlightCount--;
            this.notifyDrainIfIdle();
            try {
              await this.scheduleNextDelayedWakeup();
            } catch (rawErr) {
              const err =
                rawErr instanceof Error ? rawErr : new Error(String(rawErr));
              this.pumpErrorCount++;
              void this.emitEvent("error", this.createLifecycleJob(), err);
              this.schedulePumpRetry();
              break;
            }
            this.scheduleIdlePoll();
            break;
          }

          void this.executeJob(job);
        }
      } while (
        this.pumpAgain &&
        !this.closed &&
        !this.workersClosing &&
        !this.paused &&
        this.inFlightCount < this.concurrency
      );
    } finally {
      this.pumping = false;
    }
  }

  private async executeJob(job: Job<TData, TResult>): Promise<void> {
    let leaseTimer: ReturnType<typeof setInterval> | undefined;
    const leaseAbortController = new AbortController();
    Object.defineProperty(job, "signal", {
      value: leaseAbortController.signal,
      enumerable: false,
      configurable: true,
    });

    if (
      job.leaseToken !== undefined &&
      typeof this.driver.renewLease === "function"
    ) {
      const leaseWindowMs =
        job.leaseExpiresAt !== undefined && job.startedAt !== undefined
          ? Math.max(20, job.leaseExpiresAt - job.startedAt)
          : (this.driver.lockDurationMs ?? 30_000);
      const renewEveryMs = Math.max(10, Math.floor(leaseWindowMs / 2));
      const token = job.leaseToken;
      leaseTimer = setInterval(() => {
        if (this.closed) {
          return;
        }
        void this.driver
          .renewLease?.(this.name, job.id, token, leaseWindowMs)
          .then((renewed) => {
            if (renewed === false) {
              if (leaseTimer !== undefined) {
                clearInterval(leaseTimer);
                this.activeLeaseTimers.delete(leaseTimer);
                leaseTimer = undefined;
              }
              const lockErr = new Error(
                `Lease renewal failed for job "${job.id}" on queue "${this.name}".`,
              );
              if (!leaseAbortController.signal.aborted) {
                leaseAbortController.abort(lockErr);
              }
              void this.emitEvent("lockRenewalFailed", job, lockErr);
            }
          })
          .catch((rawErr) => {
            const err =
              rawErr instanceof Error ? rawErr : new Error(String(rawErr));
            void this.emitEvent("error", job, err);
          });
      }, renewEveryMs);
      if (typeof (leaseTimer as { unref?: () => void }).unref === "function") {
        (leaseTimer as { unref: () => void }).unref();
      }
      this.activeLeaseTimers.add(leaseTimer);
    }

    try {
      const handler = this.resolveHandler(job.name);
      if (!handler) {
        const missingErr = new Error(
          `No processor registered for job "${job.name}" on queue "${this.name}".`,
        );
        try {
          const dlqJob =
            (await this.driver.moveToDeadLetter<TData, TResult>(
              this.name,
              job.id,
              missingErr,
              job.leaseToken,
            )) ?? job;
          await this.emitEvent("dead-letter", dlqJob, missingErr);
        } catch (dlqRawErr) {
          const dlqErr =
            dlqRawErr instanceof Error
              ? dlqRawErr
              : new Error(String(dlqRawErr));
          await this.emitEvent("error", job, dlqErr);
        }
        return;
      }

      if (
        job.childrenValues !== undefined &&
        typeof job.getChildrenValues !== "function"
      ) {
        const snapshot = { ...job.childrenValues };
        job.getChildrenValues = async <T = unknown>() =>
          ({ ...snapshot }) as Record<string, T>;
      }

      await this.emitEvent("active", job);

      let result: TResult | undefined;
      let handlerErr: Error | undefined;
      let failed = false;
      try {
        result = await this.runWithTimeout(
          job,
          handler,
          leaseAbortController,
        );
      } catch (rawErr) {
        failed = true;
        handlerErr =
          rawErr instanceof Error ? rawErr : new Error(String(rawErr));
      }

      if (!failed) {
        try {
          const completedJob = await this.driver.ack<TData, TResult>(
            this.name,
            job.id,
            result as TResult,
            job.leaseToken,
          );
          if (completedJob !== null) {
            await this.emitEvent("completed", completedJob, result);
          }
        } catch (ackRawErr) {
          const ackErr =
            ackRawErr instanceof Error
              ? ackRawErr
              : new Error(String(ackRawErr));
          await this.emitEvent("error", job, ackErr);
        }
        return;
      }

      const err = handlerErr!;
      const nextAttempts = job.attemptsMade + 1;

      if (nextAttempts < job.maxAttempts) {
        const delayMs = calculateBackoffDelay(job.backoff, nextAttempts);
        const retryAt = Date.now() + delayMs;
        try {
          const nacked = await this.driver.nack<TData, TResult>(
            this.name,
            job.id,
            err,
            retryAt,
            job.leaseToken,
          );
          if (nacked !== null) {
            await this.emitEvent("failed", nacked, err);
            if (!this.closed && !this.workersClosing && !this.paused) {
              try {
                await this.scheduleNextDelayedWakeup();
              } catch (wakeupRawErr) {
                const wakeupErr =
                  wakeupRawErr instanceof Error
                    ? wakeupRawErr
                    : new Error(String(wakeupRawErr));
                await this.emitEvent("error", job, wakeupErr);
              }
            }
          }
        } catch (nackRawErr) {
          const nackErr =
            nackRawErr instanceof Error
              ? nackRawErr
              : new Error(String(nackRawErr));
          await this.emitEvent("error", job, nackErr);
        }
      } else {
        try {
          const dlqJob = await this.driver.moveToDeadLetter<TData, TResult>(
            this.name,
            job.id,
            err,
            job.leaseToken,
          );
          if (dlqJob !== null) {
            await this.emitEvent("failed", dlqJob, err);
            await this.emitEvent("dead-letter", dlqJob, err);
          }
        } catch (dlqRawErr) {
          const dlqErr =
            dlqRawErr instanceof Error
              ? dlqRawErr
              : new Error(String(dlqRawErr));
          await this.emitEvent("error", job, dlqErr);
        }
      }
    } finally {
      if (leaseTimer !== undefined) {
        clearInterval(leaseTimer);
        this.activeLeaseTimers.delete(leaseTimer);
      }
      this.inFlightCount--;
      this.notifyDrainIfIdle();
      if (!this.closed && !this.workersClosing && !this.paused) {
        this.triggerPump();
      }
    }
  }

  private async runWithTimeout(
    job: Job<TData, TResult>,
    handler: JobHandler<TData, TResult>,
    abortController: AbortController,
  ): Promise<TResult> {
    const invoke = handler as (
      job: Job<TData, TResult>,
      token?: string,
      signal?: AbortSignal,
    ) => Promise<TResult> | TResult;

    if (!job.timeoutMs || job.timeoutMs <= 0) {
      return await invoke(job, job.leaseToken, abortController.signal);
    }

    return await new Promise<TResult>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        this.activeJobTimers.delete(timer);
        if (!settled) {
          settled = true;
          const timeoutErr = new JobTimeoutError(job.id, job.timeoutMs!);
          if (!abortController.signal.aborted) {
            abortController.abort(timeoutErr);
          }
          reject(timeoutErr);
        }
      }, job.timeoutMs);
      unrefTimer(timer);
      this.activeJobTimers.add(timer);

      Promise.resolve()
        .then(() => invoke(job, job.leaseToken, abortController.signal))
        .then(
          (value) => {
            clearTimeout(timer);
            this.activeJobTimers.delete(timer);
            if (!settled) {
              settled = true;
              resolve(value);
            }
          },
          (err) => {
            clearTimeout(timer);
            this.activeJobTimers.delete(timer);
            if (!settled) {
              settled = true;
              reject(err);
            }
          },
        );
    });
  }

  private async scheduleNextDelayedWakeup(): Promise<void> {
    if (this.closed || this.workersClosing || this.paused) {
      return;
    }

    let delayMs: number | null = null;
    if (typeof this.driver.getNextDelayedTimestamp === "function") {
      const nextTs = await this.driver.getNextDelayedTimestamp(this.name);
      if (nextTs !== null) {
        delayMs = Math.max(0, nextTs - Date.now());
      }
    } else {
      const counts = await this.driver.getCounts(this.name);
      if (counts.delayed > 0) {
        delayMs = this.pollIntervalMs;
      }
    }

    if (delayMs === null || this.closed || this.workersClosing || this.paused) {
      return;
    }

    this.clearDelayedTimer();
    this.delayedTimer = setTimeout(() => {
      this.delayedTimer = undefined;
      this.triggerPump();
    }, delayMs);
    unrefTimer(this.delayedTimer);
  }

  private clearDelayedTimer(): void {
    if (this.delayedTimer !== undefined) {
      clearTimeout(this.delayedTimer);
      this.delayedTimer = undefined;
    }
  }

  private scheduleIdlePoll(): void {
    if (
      this.idlePollIntervalMs <= 0 ||
      this.closed ||
      this.workersClosing ||
      this.paused ||
      !this.hasHandlers() ||
      this.pollTimer !== undefined
    ) {
      return;
    }
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      this.triggerPump();
    }, this.idlePollIntervalMs);
    unrefTimer(this.pollTimer);
  }

  private clearPollTimer(): void {
    if (this.pollTimer !== undefined) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private schedulePumpRetry(): void {
    if (
      this.closed ||
      this.workersClosing ||
      this.paused ||
      !this.hasHandlers()
    ) {
      return;
    }
    this.clearPumpRetryTimer();
    const baseDelayMs = Math.min(50, this.pollIntervalMs);
    const exponent = Math.min(this.pumpErrorCount - 1, 10);
    const delayMs = Math.min(5_000, baseDelayMs * 2 ** exponent);
    this.pumpRetryTimer = setTimeout(() => {
      this.pumpRetryTimer = undefined;
      this.triggerPump();
    }, delayMs);
    unrefTimer(this.pumpRetryTimer);
  }

  private clearPumpRetryTimer(): void {
    if (this.pumpRetryTimer !== undefined) {
      clearTimeout(this.pumpRetryTimer);
      this.pumpRetryTimer = undefined;
    }
  }

  private createLifecycleJob(): Job<TData, TResult> {
    const now = Date.now();
    return {
      id: "",
      queueName: this.name,
      name: "",
      data: undefined as TData,
      priority: 0,
      maxAttempts: 1,
      attemptsMade: 0,
      status: "waiting",
      removeOnComplete: false,
      createdAt: now,
      processAfter: now,
      stacktrace: [],
    };
  }

  private notifyDrainIfIdle(): void {
    if (this.inFlightCount === 0) {
      void this.emitLifecycleEvent("drained");
      if (this.drainWaiters.size > 0) {
        for (const waiter of [...this.drainWaiters]) {
          waiter();
        }
      }
    }
  }

  private async emitLifecycleEvent(event: BullMQQueueEventName): Promise<void> {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) {
      return;
    }
    const stubJob = this.createLifecycleJob();
    for (const listener of [...set]) {
      try {
        await listener(stubJob);
      } catch {
        // Never allow event listener exceptions to crash the worker loop
      }
    }
  }

  private async emitEvent(
    event: BullMQQueueEventName,
    job: Job<TData, TResult>,
    payload?: unknown,
  ): Promise<void> {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) {
      return;
    }
    for (const listener of [...set]) {
      try {
        await listener(job, payload);
      } catch {
        // Never allow event listener exceptions to crash the worker loop
      }
    }
  }
}
