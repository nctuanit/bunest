import { getAmbientTraceparent } from "@bunest/core";
import {
  WorkerAbortedException,
  WorkerTaskNotFoundException,
  WorkerTerminatedException,
  WorkerTimeoutException,
} from "./errors";
import type {
  WorkerHandlerMap,
  WorkerPoolHealthSnapshot,
  WorkerPoolLike,
  WorkerPoolStats,
  WorkerRunOptions,
  WorkerTaskContext,
  WorkerTaskHandler,
} from "./interfaces";
import { unwrapTransferable } from "./protocol";
import {
  isWorkerContract,
  validateWithStandardSchema,
  type WorkerContract,
} from "./worker-contract";

export interface InProcessWorkerPoolOptions {
  readonly name?: string;
  readonly initData?: unknown;
  readonly taskTimeoutMs?: number;
}

/**
 * Deterministic in-process test double implementing `WorkerPoolLike` without
 * spawning OS threads — ideal for fast unit tests with full `WorkerContract`
 * validation, timeout, `AbortSignal`, progress callback, and stats fidelity.
 */
export class InProcessWorkerPool implements WorkerPoolLike {
  readonly name: string;
  private readonly handlers: Map<string, WorkerTaskHandler<any, any>>;
  private readonly initData?: unknown;
  private readonly defaultTimeoutMs: number;
  private closed = false;
  private seq = 0;
  private completedTasks = 0;
  private failedTasks = 0;
  private timedOutTasks = 0;
  private cancelledTasks = 0;

  constructor(
    handlers: WorkerTaskHandler<any, any> | WorkerHandlerMap,
    options: InProcessWorkerPoolOptions = {},
  ) {
    this.name = options.name ?? "in-process";
    this.initData = options.initData;
    this.defaultTimeoutMs = Math.max(0, options.taskTimeoutMs ?? 30_000);
    this.handlers = new Map();
    if (typeof handlers === "function") {
      this.handlers.set("default", handlers);
      this.handlers.set("*", handlers);
    } else {
      for (const [k, v] of Object.entries(handlers)) {
        if (typeof v === "function") {
          this.handlers.set(k, v);
        }
      }
    }
  }

  async run<TInput = unknown, TOutput = unknown>(
    taskOrContract: string | WorkerContract<string, TInput, TOutput>,
    rawPayload: TInput,
    options?: WorkerRunOptions,
  ): Promise<TOutput> {
    if (this.closed) {
      throw new WorkerTerminatedException(
        `InProcessWorkerPool "${this.name}" is closed.`,
      );
    }

    const contract = isWorkerContract(taskOrContract)
      ? taskOrContract
      : undefined;
    const taskName = contract ? contract.name : (taskOrContract as string);
    const merged: WorkerRunOptions = contract?.defaultOptions
      ? { ...contract.defaultOptions, ...options }
      : (options ?? {});

    if (merged.signal?.aborted) {
      this.cancelledTasks += 1;
      throw new WorkerAbortedException(merged.signal.reason);
    }

    const unwrapped = unwrapTransferable(rawPayload);
    const payload = contract?.inputSchema
      ? await validateWithStandardSchema(
          taskName,
          contract.inputSchema,
          unwrapped.value,
        )
      : unwrapped.value;

    const handler = this.handlers.get(taskName) ?? this.handlers.get("*");
    if (!handler) {
      this.failedTasks += 1;
      throw new WorkerTaskNotFoundException(
        taskName,
        [...this.handlers.keys()].filter((k) => k !== "*"),
      );
    }

    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort(merged.signal?.reason);
    merged.signal?.addEventListener("abort", onAbort, { once: true });

    const ctx: WorkerTaskContext = {
      taskId: `${this.name}-${++this.seq}`,
      taskName,
      workerId: `${this.name}-inproc`,
      signal: ctrl.signal,
      initData: this.initData,
      traceparent: getAmbientTraceparent(),
      reportProgress(progress: unknown): void {
        merged.onProgress?.(progress);
      },
    };

    const timeoutMs = merged.timeoutMs ?? this.defaultTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const execPromise = Promise.resolve(handler(payload, ctx)).then((res) => {
        const out = unwrapTransferable(res).value;
        return contract?.outputSchema
          ? validateWithStandardSchema(taskName, contract.outputSchema, out)
          : (out as TOutput);
      });

      const races: Promise<TOutput>[] = [execPromise];

      if (timeoutMs > 0) {
        races.push(
          new Promise<never>((_res, rej) => {
            timer = setTimeout(() => {
              ctrl.abort("timeout");
              rej(new WorkerTimeoutException(taskName, timeoutMs, this.name));
            }, timeoutMs);
          }),
        );
      }

      if (merged.signal) {
        races.push(
          new Promise<never>((_res, rej) => {
            merged.signal?.addEventListener(
              "abort",
              () => rej(new WorkerAbortedException(merged.signal?.reason)),
              { once: true },
            );
          }),
        );
      }

      const result = await Promise.race(races);
      this.completedTasks += 1;
      return result;
    } catch (err) {
      if (err instanceof WorkerTimeoutException) this.timedOutTasks += 1;
      else if (err instanceof WorkerAbortedException) this.cancelledTasks += 1;
      else this.failedTasks += 1;
      throw err;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      merged.signal?.removeEventListener("abort", onAbort);
    }
  }

  getStats(): WorkerPoolStats {
    return {
      name: this.name,
      closed: this.closed,
      minThreads: 1,
      maxThreads: 1,
      activeWorkers: 0,
      idleWorkers: this.closed ? 0 : 1,
      startingWorkers: 0,
      totalWorkers: this.closed ? 0 : 1,
      queuedTasks: 0,
      maxQueueSize: 1,
      completedTasks: this.completedTasks,
      failedTasks: this.failedTasks,
      timedOutTasks: this.timedOutTasks,
      cancelledTasks: this.cancelledTasks,
      workersSpawned: 1,
      workersRecycled: 0,
      workersCrashed: 0,
      consecutiveCrashes: 0,
    };
  }

  getHealthSnapshot(): WorkerPoolHealthSnapshot {
    return {
      name: this.name,
      healthy: !this.closed,
      closed: this.closed,
      totalWorkers: this.closed ? 0 : 1,
      activeWorkers: 0,
      idleWorkers: this.closed ? 0 : 1,
      queuedTasks: 0,
      maxQueueSize: 1,
      maxThreads: 1,
      consecutiveCrashes: 0,
      queueUtilization: 0,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
