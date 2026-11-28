import {
  ClsContextPropagator,
  ClsService,
  diagnosticsChannel,
  getAmbientClsStore,
  getAmbientTraceparent,
  getCpuCount,
  type ClsContextCarrier,
  type ClsServiceLike,
} from "@bunest/core";
import {
  WorkerAbortedException,
  WorkerPoolSaturatedException,
  WorkerTerminatedException,
  WorkerTimeoutException,
} from "./errors";
import type {
  WorkerDispatchDiagnosticEvent,
  WorkerLifecycleDiagnosticEvent,
  WorkerMapOptions,
  WorkerPoolHealthSnapshot,
  WorkerPoolLike,
  WorkerPoolOptions,
  WorkerPoolStats,
  WorkerRunOptions,
} from "./interfaces";
import {
  WORKER_PROTOCOL_VERSION,
  unwrapTransferable,
  type MainToWorkerFrame,
} from "./protocol";
import {
  isWorkerContract,
  validateWithStandardSchema,
  type WorkerContract,
} from "./worker-contract";
import { WorkerSlot } from "./worker-slot";

/** Diagnostics channel emitted around worker task dispatches (`start` / `end` / `error`). */
export const WORKERS_DISPATCH_CHANNEL = "bunest:workers:dispatch";

/** Diagnostics channel emitted on worker thread lifecycle transitions. */
export const WORKERS_LIFECYCLE_CHANNEL = "bunest:workers:lifecycle";

const dispatchChannel = diagnosticsChannel(WORKERS_DISPATCH_CHANNEL);
const lifecycleChannel = diagnosticsChannel(WORKERS_LIFECYCLE_CHANNEL);

interface QueuedTask {
  readonly id: string;
  readonly taskName: string;
  readonly payload: unknown;
  readonly transfer?: Bun.Transferable[];
  readonly priority: number;
  readonly seq: number;
  readonly enqueuedAt: number;
  readonly timeoutMs: number;
  readonly terminateOnTimeout: boolean;
  readonly terminateOnAbort: boolean;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: unknown) => void;
  readonly cls?: ClsContextCarrier;
  readonly traceparent?: string;
  readonly contract?: WorkerContract<any, any, any>;
  readonly resolve: (value: any) => void;
  readonly reject: (err: Error) => void;
  abortCleanup?: () => void;
}

let sharedFallbackClsService: ClsService | undefined;

function getDefaultClsService(): ClsService {
  if (!sharedFallbackClsService) {
    sharedFallbackClsService = new ClsService({ generateId: false });
  }
  return sharedFallbackClsService;
}

function resolveDefaultMaxThreads(): number {
  return Math.max(1, getCpuCount() - 1);
}

/**
 * Managed pool of native Bun `Worker` threads with:
 * - Dynamic scaling (`minThreads`..`maxThreads`)
 * - Bounded priority queue & backpressure (`maxQueueSize`)
 * - Zero-copy `Transferable` payloads & outputs
 * - Cooperative `AbortSignal` cancellation + hung-CPU `timeoutMs` recovery
 * - `smol`, `preload`, `env`, `argv`, `unrefWhenIdle`, idle eviction & `maxTasksPerWorker` recycling
 * - Automatic CLS (`ClsContextPropagator`) & W3C `traceparent` propagation
 * - `diagnosticsChannel` telemetry (`bunest:workers:dispatch` / `bunest:workers:lifecycle`)
 */
export class WorkerPool implements WorkerPoolLike {
  readonly name: string;
  readonly minThreads: number;
  readonly maxThreads: number;
  readonly maxQueueSize: number;

  private readonly options: WorkerPoolOptions;
  private readonly defaultTaskTimeoutMs: number;
  private readonly startupTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly maxTasksPerWorker: number;
  private readonly unrefWhenIdle: boolean;
  private readonly defaultTerminateOnTimeout: boolean;
  private readonly cancelGraceMs: number;
  private readonly maxConsecutiveCrashes: number;
  private readonly clsService?: ClsServiceLike;
  private readonly clsPropagator: ClsContextPropagator;

  private readonly slots = new Set<WorkerSlot>();
  private readonly queue: QueuedTask[] = [];
  private readonly drainWaiters: Array<() => void> = [];

  private workerSeq = 0;
  private taskSeq = 0;
  private closed = false;
  private closingPromise?: Promise<void>;
  private idleSweepTimer?: ReturnType<typeof setInterval>;

  private completedTasks = 0;
  private failedTasks = 0;
  private timedOutTasks = 0;
  private cancelledTasks = 0;
  private workersSpawned = 0;
  private workersRecycled = 0;
  private workersCrashed = 0;
  private consecutiveCrashes = 0;
  private inFlightCount = 0;

  constructor(options: WorkerPoolOptions) {
    if (!options?.script) {
      throw new Error(
        "WorkerPool requires a `script` path or URL (e.g. `new URL('./my.worker.ts', import.meta.url)`).",
      );
    }

    this.options = options;
    this.name = options.name?.trim() || "default";
    this.maxThreads = Math.max(
      1,
      Math.floor(options.maxThreads ?? resolveDefaultMaxThreads()),
    );
    this.minThreads = Math.min(
      this.maxThreads,
      Math.max(0, Math.floor(options.minThreads ?? 0)),
    );
    this.maxQueueSize = Math.max(
      1,
      Math.floor(options.maxQueueSize ?? 1024),
    );
    this.defaultTaskTimeoutMs = Math.max(
      0,
      Math.floor(options.taskTimeoutMs ?? 30_000),
    );
    this.startupTimeoutMs = Math.max(
      100,
      Math.floor(options.startupTimeoutMs ?? 10_000),
    );
    this.idleTimeoutMs = Math.max(
      0,
      Math.floor(options.idleTimeoutMs ?? 30_000),
    );
    this.shutdownTimeoutMs = Math.max(
      50,
      Math.floor(options.shutdownTimeoutMs ?? 5_000),
    );
    this.maxTasksPerWorker = Math.max(
      0,
      Math.floor(options.maxTasksPerWorker ?? 0),
    );
    this.unrefWhenIdle = options.unrefWhenIdle ?? true;
    this.defaultTerminateOnTimeout = options.terminateOnTimeout ?? true;
    this.cancelGraceMs = Math.max(0, Math.floor(options.cancelGraceMs ?? 100));
    this.maxConsecutiveCrashes = Math.max(
      1,
      Math.floor(options.maxConsecutiveCrashes ?? 5),
    );
    this.clsService = options.clsService;
    this.clsPropagator = new ClsContextPropagator(
      options.clsKeys ? { keys: options.clsKeys } : undefined,
    );

    if (this.idleTimeoutMs > 0) {
      const interval = Math.max(250, Math.min(5_000, Math.floor(this.idleTimeoutMs / 2)));
      this.idleSweepTimer = setInterval(() => this.sweepIdleWorkers(), interval);
      (this.idleSweepTimer as { unref?: () => void }).unref?.();
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Eagerly spawns up to `count` (defaults to `Math.max(1, minThreads)`) worker
   * threads and awaits their `READY` handshakes.
   */
  async warmUp(count?: number): Promise<void> {
    if (this.closed) {
      throw new WorkerTerminatedException(
        `Cannot warm up closed worker pool "${this.name}".`,
      );
    }
    const target = Math.min(
      this.maxThreads,
      Math.max(0, Math.floor(count ?? this.minThreads)),
    );
    const needed = Math.max(0, target - this.slots.size);
    const spawned: WorkerSlot[] = [];
    for (let i = 0; i < needed; i++) {
      spawned.push(this.spawnSlot());
    }
    await Promise.all(
      [...this.slots].slice(0, target).map((slot) => slot.readyPromise),
    );
    void spawned;
  }

  /**
   * Executes a task (by string name or typed `WorkerContract`) on a Bun Worker thread.
   */
  async run<TInput = unknown, TOutput = unknown>(
    contract: WorkerContract<string, TInput, TOutput>,
    payload: TInput,
    options?: WorkerRunOptions,
  ): Promise<TOutput>;
  async run<TInput = unknown, TOutput = unknown>(
    taskName: string,
    payload: TInput,
    options?: WorkerRunOptions,
  ): Promise<TOutput>;
  async run<TInput = unknown, TOutput = unknown>(
    taskOrContract: string | WorkerContract<string, TInput, TOutput>,
    rawPayload: TInput,
    options?: WorkerRunOptions,
  ): Promise<TOutput> {
    if (this.closed) {
      throw new WorkerTerminatedException(
        `Worker pool "${this.name}" is closed and no longer accepts tasks.`,
      );
    }

    const contract = isWorkerContract(taskOrContract)
      ? taskOrContract
      : undefined;
    const taskName = contract ? contract.name : (taskOrContract as string);
    const mergedOptions: WorkerRunOptions = contract?.defaultOptions
      ? { ...contract.defaultOptions, ...options }
      : (options ?? {});

    if (mergedOptions.signal?.aborted) {
      this.cancelledTasks += 1;
      throw new WorkerAbortedException(mergedOptions.signal.reason);
    }

    const unwrapped = unwrapTransferable(rawPayload);
    const payload = contract?.inputSchema
      ? await validateWithStandardSchema(
          taskName,
          contract.inputSchema,
          unwrapped.value,
        )
      : unwrapped.value;

    const transfer =
      mergedOptions.transfer && mergedOptions.transfer.length > 0
        ? [...mergedOptions.transfer]
        : unwrapped.transfer;

    if (this.closed) {
      throw new WorkerTerminatedException(
        `Worker pool "${this.name}" closed before task "${taskName}" could be enqueued.`,
      );
    }

    if (this.queue.length >= this.maxQueueSize) {
      const satErr = new WorkerPoolSaturatedException(
        this.name,
        this.maxQueueSize,
      );
      this.emitDispatch({
        phase: "error",
        pool: this.name,
        task: taskName,
        taskId: `${this.name}-sat-${this.taskSeq + 1}`,
        status: "saturated",
        traceparent: getAmbientTraceparent(),
        error: satErr,
      });
      throw satErr;
    }

    const { cls, traceparent } = this.captureAmbientContext();
    const taskId = `${this.name}-${++this.taskSeq}`;
    const timeoutMs = Math.max(
      0,
      Math.floor(mergedOptions.timeoutMs ?? this.defaultTaskTimeoutMs),
    );
    const priority = mergedOptions.priority ?? 0;

    return new Promise<TOutput>((resolve, reject) => {
      const entry: QueuedTask = {
        id: taskId,
        taskName,
        payload,
        transfer,
        priority,
        seq: this.taskSeq,
        enqueuedAt: performance.now(),
        timeoutMs,
        terminateOnTimeout:
          mergedOptions.terminateOnTimeout ?? this.defaultTerminateOnTimeout,
        terminateOnAbort: mergedOptions.terminateOnAbort ?? false,
        signal: mergedOptions.signal,
        onProgress: mergedOptions.onProgress,
        cls,
        traceparent,
        contract,
        resolve,
        reject,
      };

      if (entry.signal) {
        const onQueuedAbort = () => {
          const idx = this.queue.indexOf(entry);
          if (idx !== -1) {
            this.queue.splice(idx, 1);
            entry.abortCleanup?.();
            this.cancelledTasks += 1;
            const err = new WorkerAbortedException(entry.signal?.reason);
            this.emitDispatch({
              phase: "error",
              pool: this.name,
              task: entry.taskName,
              taskId: entry.id,
              queueWaitMs: Math.round((performance.now() - entry.enqueuedAt) * 100) / 100,
              durationMs: 0,
              status: "aborted",
              traceparent: entry.traceparent,
              error: err,
            });
            reject(err);
            this.checkDrained();
          }
        };
        entry.signal.addEventListener("abort", onQueuedAbort, { once: true });
        entry.abortCleanup = () => {
          entry.signal?.removeEventListener("abort", onQueuedAbort);
        };
      }

      this.enqueueTask(entry);
      this.pump();
    });
  }

  /**
   * Maps an array of items in parallel across the worker pool, preserving input order.
   */
  async map<TItem, TOutput = unknown>(
    items: readonly TItem[],
    taskOrContract: string | WorkerContract<string, TItem, TOutput>,
    options: WorkerMapOptions = {},
  ): Promise<TOutput[]> {
    if (items.length === 0) {
      return [];
    }
    const concurrency = Math.max(
      1,
      Math.min(items.length, Math.floor(options.concurrency ?? this.maxThreads)),
    );
    const { concurrency: _ignored, ...runOpts } = options;
    const results = new Array<TOutput>(items.length);
    let cursor = 0;

    const runner = async (): Promise<void> => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await this.run(
          taskOrContract as string,
          items[index],
          runOpts,
        );
      }
    };

    const workers: Promise<void>[] = [];
    for (let i = 0; i < concurrency; i++) {
      workers.push(runner());
    }
    await Promise.all(workers);
    return results;
  }

  /**
   * Broadcasts an out-of-band notification to every live worker thread in the pool
   * (e.g. cache invalidation or config refresh).
   */
  broadcast(event: string, payload?: unknown, transfer?: Bun.Transferable[]): number {
    let delivered = 0;
    for (const slot of this.slots) {
      if (slot.state === "idle" || slot.state === "busy") {
        slot.sendBroadcast(event, payload, transfer);
        delivered += 1;
      }
    }
    return delivered;
  }

  /**
   * Waits until all currently queued and in-flight tasks have settled.
   */
  drain(): Promise<void> {
    if (this.queue.length === 0 && this.inFlightCount === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.drainWaiters.push(resolve);
    });
  }

  /**
   * Stops accepting new tasks, drains or cancels pending work, and shuts down
   * every worker thread gracefully (falling back to `worker.terminate()` on timeout).
   */
  async close(options?: {
    readonly force?: boolean;
    readonly timeoutMs?: number;
  }): Promise<void> {
    if (this.closingPromise) {
      return this.closingPromise;
    }
    this.closed = true;

    if (this.idleSweepTimer !== undefined) {
      clearInterval(this.idleSweepTimer);
      this.idleSweepTimer = undefined;
    }

    const force = options?.force === true;
    const timeoutMs = options?.timeoutMs ?? this.shutdownTimeoutMs;

    this.closingPromise = (async () => {
      if (force) {
        this.rejectQueuedTasks(
          new WorkerTerminatedException(
            `Worker pool "${this.name}" was forcefully closed.`,
          ),
        );
      } else {
        // Wait for queued + in-flight tasks up to timeoutMs before tearing down slots
        if (this.queue.length > 0 || this.inFlightCount > 0) {
          let drainTimer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            this.drain(),
            new Promise<void>((resolve) => {
              drainTimer = setTimeout(resolve, timeoutMs);
              (drainTimer as { unref?: () => void }).unref?.();
            }),
          ]);
          if (drainTimer !== undefined) {
            clearTimeout(drainTimer);
          }
        }
        if (this.queue.length > 0) {
          this.rejectQueuedTasks(
            new WorkerTerminatedException(
              `Worker pool "${this.name}" closed before queued tasks could start.`,
            ),
          );
        }
      }

      const slotsToClose = [...this.slots];
      await Promise.allSettled(
        slotsToClose.map((slot) =>
          slot.close({
            force,
            timeoutMs,
            reason: `Pool "${this.name}" shutdown`,
          }),
        ),
      );
      this.slots.clear();
      this.checkDrained();

      try {
        this.options.onDispose?.();
      } catch {
        // Best-effort cleanup (e.g. URL.revokeObjectURL)
      }
    })();

    return this.closingPromise;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  getStats(): WorkerPoolStats {
    let activeWorkers = 0;
    let idleWorkers = 0;
    let startingWorkers = 0;
    for (const slot of this.slots) {
      if (slot.state === "busy") activeWorkers += 1;
      else if (slot.state === "idle") idleWorkers += 1;
      else if (slot.state === "starting") startingWorkers += 1;
    }

    return {
      name: this.name,
      closed: this.closed,
      minThreads: this.minThreads,
      maxThreads: this.maxThreads,
      activeWorkers,
      idleWorkers,
      startingWorkers,
      totalWorkers: this.slots.size,
      queuedTasks: this.queue.length,
      maxQueueSize: this.maxQueueSize,
      completedTasks: this.completedTasks,
      failedTasks: this.failedTasks,
      timedOutTasks: this.timedOutTasks,
      cancelledTasks: this.cancelledTasks,
      workersSpawned: this.workersSpawned,
      workersRecycled: this.workersRecycled,
      workersCrashed: this.workersCrashed,
      consecutiveCrashes: this.consecutiveCrashes,
    };
  }

  getHealthSnapshot(): WorkerPoolHealthSnapshot {
    const stats = this.getStats();
    const queueUtilization =
      stats.maxQueueSize > 0 ? stats.queuedTasks / stats.maxQueueSize : 0;
    const healthy =
      !stats.closed &&
      stats.consecutiveCrashes < this.maxConsecutiveCrashes &&
      queueUtilization < 1;

    return {
      name: stats.name,
      healthy,
      closed: stats.closed,
      totalWorkers: stats.totalWorkers,
      activeWorkers: stats.activeWorkers,
      idleWorkers: stats.idleWorkers,
      queuedTasks: stats.queuedTasks,
      maxQueueSize: stats.maxQueueSize,
      maxThreads: stats.maxThreads,
      consecutiveCrashes: stats.consecutiveCrashes,
      queueUtilization,
    };
  }

  // -------------------------------------------------------------------------
  // Internal Scheduling, Lifecycle & Telemetry
  // -------------------------------------------------------------------------

  private captureAmbientContext(): {
    readonly cls?: ClsContextCarrier;
    readonly traceparent?: string;
  } {
    const traceparent = getAmbientTraceparent();
    const activeCls =
      this.clsService && this.clsService.isActive()
        ? this.clsService
        : getAmbientClsStore()
          ? getDefaultClsService()
          : undefined;

    if (activeCls) {
      const captured = this.clsPropagator.capture(activeCls);
      if (
        captured.clsId !== undefined ||
        captured.traceparent !== undefined ||
        Object.keys(captured.values).length > 0
      ) {
        return {
          cls: captured,
          traceparent: captured.traceparent ?? traceparent,
        };
      }
    }

    if (traceparent) {
      return {
        cls: { traceparent, values: {} },
        traceparent,
      };
    }

    return {};
  }

  private enqueueTask(entry: QueuedTask): void {
    if (
      this.queue.length === 0 ||
      this.queue[this.queue.length - 1]!.priority >= entry.priority
    ) {
      this.queue.push(entry);
      return;
    }
    let idx = this.queue.length - 1;
    while (idx > 0 && this.queue[idx - 1]!.priority < entry.priority) {
      idx -= 1;
    }
    this.queue.splice(idx, 0, entry);
  }

  private pump(): void {
    if (this.queue.length === 0) {
      return;
    }

    // 1. Dispatch to already-idle slots first
    for (const slot of this.slots) {
      if (this.queue.length === 0) {
        return;
      }
      if (slot.state === "idle") {
        const next = this.queue.shift()!;
        this.dispatchToSlot(slot, next);
      }
    }

    // 2. Scale up new slots while queue still has waiting tasks
    while (
      !this.closed &&
      this.queue.length > 0 &&
      this.slots.size < this.maxThreads &&
      this.countStartingSlots() < this.queue.length
    ) {
      try {
        this.spawnSlot();
      } catch (err) {
        // Immediate constructor failure (e.g. invalid URL) — fail all queued tasks
        this.rejectQueuedTasks(
          err instanceof Error ? err : new Error(String(err)),
        );
        return;
      }
    }
  }

  private countStartingSlots(): number {
    let count = 0;
    for (const slot of this.slots) {
      if (slot.state === "starting") count += 1;
    }
    return count;
  }

  private spawnSlot(): WorkerSlot {
    const workerId = `${this.name}-w${++this.workerSeq}`;
    this.workersSpawned += 1;

    this.emitLifecycle({
      event: "spawn",
      pool: this.name,
      workerId,
    });

    const slot = new WorkerSlot(
      {
        workerId,
        poolName: this.name,
        script: this.options.script,
        smol: this.options.smol,
        preload: this.options.preload,
        env: this.options.env,
        argv: this.options.argv,
        ref: this.options.ref,
        name: this.options.name ?? this.name,
        startupTimeoutMs: this.startupTimeoutMs,
        shutdownTimeoutMs: this.shutdownTimeoutMs,
        unrefWhenIdle: this.unrefWhenIdle,
        initData: this.options.initData,
      },
      {
        onReady: (readySlot) => {
          this.consecutiveCrashes = 0;
          this.emitLifecycle({
            event: "ready",
            pool: this.name,
            workerId: readySlot.workerId,
          });
          this.pump();
        },
        onIdle: (idleSlot) => {
          if (
            this.maxTasksPerWorker > 0 &&
            idleSlot.tasksExecuted >= this.maxTasksPerWorker
          ) {
            this.recycleSlot(idleSlot);
            return;
          }
          this.pump();
        },
        onCrash: (crashedSlot, err, exitCode) => {
          this.slots.delete(crashedSlot);
          this.workersCrashed += 1;
          this.consecutiveCrashes += 1;

          this.emitLifecycle({
            event: "crash",
            pool: this.name,
            workerId: crashedSlot.workerId,
            exitCode,
            tasksExecuted: crashedSlot.tasksExecuted,
            error: err,
          });

          if (this.closed) {
            return;
          }

          // If we have hit consecutive startup/crash limit and no live slots remain,
          // fail waiting tasks rather than spinning infinitely.
          if (
            this.consecutiveCrashes >= this.maxConsecutiveCrashes &&
            this.slots.size === 0
          ) {
            this.rejectQueuedTasks(err);
            return;
          }

          if (this.queue.length > 0) {
            this.pump();
          } else if (this.slots.size < this.minThreads) {
            try {
              this.spawnSlot();
            } catch {
              // Handled via consecutive crash budget
            }
          }
        },
        onClose: (closedSlot, exitCode) => {
          this.slots.delete(closedSlot);
          this.emitLifecycle({
            event: "close",
            pool: this.name,
            workerId: closedSlot.workerId,
            exitCode,
            tasksExecuted: closedSlot.tasksExecuted,
          });
          this.checkDrained();
        },
      },
    );

    this.slots.add(slot);
    return slot;
  }

  private dispatchToSlot(slot: WorkerSlot, entry: QueuedTask): void {
    entry.abortCleanup?.();

    if (entry.signal?.aborted) {
      this.cancelledTasks += 1;
      entry.reject(new WorkerAbortedException(entry.signal.reason));
      this.pump();
      this.checkDrained();
      return;
    }

    const startedAt = performance.now();
    const queueWaitMs = Math.round((startedAt - entry.enqueuedAt) * 100) / 100;
    this.inFlightCount += 1;

    this.emitDispatch({
      phase: "start",
      pool: this.name,
      task: entry.taskName,
      taskId: entry.id,
      workerId: slot.workerId,
      queueWaitMs,
      traceparent: entry.traceparent,
    });

    let settled = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelGraceTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanupTimers = () => {
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
      if (cancelGraceTimer !== undefined) {
        clearTimeout(cancelGraceTimer);
        cancelGraceTimer = undefined;
      }
      if (entry.signal && onRunningAbort) {
        entry.signal.removeEventListener("abort", onRunningAbort);
      }
    };

    const finalize = (
      outcome:
        | { readonly ok: true; readonly value: unknown }
        | {
            readonly ok: false;
            readonly err: Error;
            readonly status: "failed" | "timeout" | "aborted";
          },
    ) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      this.inFlightCount = Math.max(0, this.inFlightCount - 1);
      const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;

      if (outcome.ok) {
        this.completedTasks += 1;
        this.emitDispatch({
          phase: "end",
          pool: this.name,
          task: entry.taskName,
          taskId: entry.id,
          workerId: slot.workerId,
          queueWaitMs,
          durationMs,
          status: "completed",
          traceparent: entry.traceparent,
        });
        entry.resolve(outcome.value);
      } else {
        if (outcome.status === "timeout") this.timedOutTasks += 1;
        else if (outcome.status === "aborted") this.cancelledTasks += 1;
        else this.failedTasks += 1;

        this.emitDispatch({
          phase: "error",
          pool: this.name,
          task: entry.taskName,
          taskId: entry.id,
          workerId: slot.workerId,
          queueWaitMs,
          durationMs,
          status: outcome.status,
          traceparent: entry.traceparent,
          error: outcome.err,
        });
        entry.reject(outcome.err);
      }
      this.checkDrained();
    };

    const onRunningAbort = entry.signal
      ? () => {
          if (settled) return;
          const reason =
            typeof entry.signal?.reason === "string"
              ? entry.signal.reason
              : entry.signal?.reason instanceof Error
                ? entry.signal.reason.message
                : undefined;
          slot.sendCancel(entry.id, reason);

          if (entry.terminateOnAbort) {
            cancelGraceTimer = setTimeout(() => {
              if (!settled && slot.currentTaskId === entry.id) {
                this.slots.delete(slot);
                slot.forceTerminate(
                  `Worker "${slot.workerId}" forcefully terminated after task abort.`,
                );
                this.pump();
              }
            }, this.cancelGraceMs);
            (cancelGraceTimer as { unref?: () => void }).unref?.();
          }

          finalize({
            ok: false,
            err: new WorkerAbortedException(entry.signal?.reason),
            status: "aborted",
          });
        }
      : undefined;

    if (entry.signal && onRunningAbort) {
      entry.signal.addEventListener("abort", onRunningAbort, { once: true });
    }

    if (entry.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        if (settled) return;
        const timeoutErr = new WorkerTimeoutException(
          entry.taskName,
          entry.timeoutMs,
          this.name,
        );
        // Settle the caller with WorkerTimeoutException BEFORE terminating the slot
        // so slot.forceTerminate() cannot shadow it with WorkerTerminatedException.
        finalize({ ok: false, err: timeoutErr, status: "timeout" });

        slot.sendCancel(entry.id, timeoutErr.message);

        if (entry.terminateOnTimeout) {
          this.slots.delete(slot);
          slot.forceTerminate(timeoutErr.message);
          this.pump();
        }
      }, entry.timeoutMs);
      (timeoutTimer as { unref?: () => void }).unref?.();
    }

    const frame: Extract<MainToWorkerFrame, { t: "task" }> = {
      __bw: WORKER_PROTOCOL_VERSION,
      t: "task",
      id: entry.id,
      task: entry.taskName,
      payload: entry.payload,
      ...(entry.cls ? { cls: entry.cls } : {}),
      ...(entry.traceparent ? { traceparent: entry.traceparent } : {}),
    };

    slot.dispatch(
      frame,
      {
        id: entry.id,
        taskName: entry.taskName,
        onProgress: entry.onProgress,
        resolve: (value) => {
          if (entry.contract?.outputSchema) {
            void validateWithStandardSchema(
              entry.taskName,
              entry.contract.outputSchema,
              value,
            )
              .then((validated) => finalize({ ok: true, value: validated }))
              .catch((err) =>
                finalize({
                  ok: false,
                  err: err instanceof Error ? err : new Error(String(err)),
                  status: "failed",
                }),
              );
            return;
          }
          finalize({ ok: true, value });
        },
        reject: (err) => {
          finalize({ ok: false, err, status: "failed" });
        },
      },
      entry.transfer,
    );
  }

  private recycleSlot(slot: WorkerSlot): void {
    if (!this.slots.has(slot)) return;
    this.slots.delete(slot);
    this.workersRecycled += 1;

    this.emitLifecycle({
      event: "recycle",
      pool: this.name,
      workerId: slot.workerId,
      tasksExecuted: slot.tasksExecuted,
    });

    void slot.close({ reason: "maxTasksPerWorker reached" });
    if (!this.closed && (this.queue.length > 0 || this.slots.size < this.minThreads)) {
      this.pump();
      if (this.queue.length === 0 && this.slots.size < this.minThreads) {
        try {
          this.spawnSlot();
        } catch {
          // Best-effort warm refill
        }
      }
    }
  }

  private sweepIdleWorkers(): void {
    if (this.closed || this.idleTimeoutMs <= 0) return;
    const now = Date.now();
    for (const slot of [...this.slots]) {
      if (this.slots.size <= this.minThreads) {
        break;
      }
      if (slot.state === "idle" && now - slot.lastUsedAt >= this.idleTimeoutMs) {
        this.slots.delete(slot);
        this.emitLifecycle({
          event: "evict",
          pool: this.name,
          workerId: slot.workerId,
          tasksExecuted: slot.tasksExecuted,
        });
        void slot.close({ reason: "idle timeout" });
      }
    }
  }

  private rejectQueuedTasks(err: Error): void {
    for (const queued of this.queue.splice(0)) {
      queued.abortCleanup?.();
      this.failedTasks += 1;
      queued.reject(err);
    }
    this.checkDrained();
  }

  private checkDrained(): void {
    if (this.queue.length === 0 && this.inFlightCount === 0) {
      for (const resolve of this.drainWaiters.splice(0)) {
        resolve();
      }
    }
  }

  private emitDispatch(event: WorkerDispatchDiagnosticEvent): void {
    if (dispatchChannel.hasSubscribers) {
      dispatchChannel.publish(event);
    }
  }

  private emitLifecycle(event: WorkerLifecycleDiagnosticEvent): void {
    if (lifecycleChannel.hasSubscribers) {
      lifecycleChannel.publish(event);
    }
  }
}
