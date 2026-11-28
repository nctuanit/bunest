import { getCpuCount } from "@bunest/core";
import type { BunWorkerRuntimeOptions, WorkerScriptTarget } from "./interfaces";
import { isMainThread } from "./worker-host";

export interface WorkerClusterOptions extends BunWorkerRuntimeOptions {
  /**
   * Worker entrypoint script (each worker thread should call
   * `app.listen({ port, reusePort: true })`).
   */
  readonly script: WorkerScriptTarget;

  /**
   * Number of Bun Worker threads to spawn.
   * Defaults to `getCpuCount()` (`navigator.hardwareConcurrency`).
   */
  readonly workers?: number;

  /**
   * Automatically respawn a worker thread if it exits unexpectedly.
   * @default true
   */
  readonly restartOnCrash?: boolean;

  /**
   * Delay in ms before respawning a crashed worker.
   * @default 500
   */
  readonly restartDelayMs?: number;

  /**
   * Maximum restart attempts per slot before giving up.
   * @default 5
   */
  readonly maxRestarts?: number;

  /**
   * Graceful shutdown timeout (ms) after sending `{ type: "cluster:shutdown" }`
   * before forcefully terminating remaining workers.
   * @default 5_000
   */
  readonly shutdownTimeoutMs?: number;

  /**
   * Optional lifecycle observer callbacks.
   */
  readonly onWorkerReady?: (workerIndex: number) => void;
  readonly onWorkerExit?: (workerIndex: number, exitCode?: number) => void;
  readonly onWorkerError?: (workerIndex: number, error: Error) => void;
}

export interface WorkerClusterStatus {
  readonly running: boolean;
  readonly desiredWorkers: number;
  readonly liveWorkers: number;
  readonly totalRestarts: number;
}

/**
 * Multi-thread HTTP/server cluster supervisor built purely on native Bun
 * `Worker` threads and `Bun.serve({ reusePort: true })` (zero `node:cluster`
 * or `node:worker_threads`).
 *
 * Note: Kernel-level `SO_REUSEPORT` load balancing is recommended on Linux.
 * On macOS/Windows, kernel connection distribution across threads may be uneven.
 */
export class BunestWorkerCluster {
  private readonly options: WorkerClusterOptions;
  private readonly desiredWorkers: number;
  private readonly restartOnCrash: boolean;
  private readonly restartDelayMs: number;
  private readonly maxRestarts: number;
  private readonly shutdownTimeoutMs: number;

  private readonly workers = new Map<number, Worker>();
  private readonly restartCounts = new Map<number, number>();
  private readonly restartTimers = new Set<ReturnType<typeof setTimeout>>();
  private running = false;
  private stopping = false;
  private totalRestarts = 0;

  constructor(options: WorkerClusterOptions) {
    this.options = options;
    this.desiredWorkers = Math.max(
      1,
      Math.floor(options.workers ?? getCpuCount()),
    );
    this.restartOnCrash = options.restartOnCrash ?? true;
    this.restartDelayMs = Math.max(0, Math.floor(options.restartDelayMs ?? 500));
    this.maxRestarts = Math.max(0, Math.floor(options.maxRestarts ?? 5));
    this.shutdownTimeoutMs = Math.max(
      50,
      Math.floor(options.shutdownTimeoutMs ?? 5_000),
    );
  }

  start(): void {
    if (!isMainThread()) {
      throw new Error(
        "BunestWorkerCluster.start() must only be called on the main thread (check isMainThread()).",
      );
    }
    if (this.running) {
      return;
    }
    this.running = true;
    this.stopping = false;

    for (let i = 0; i < this.desiredWorkers; i++) {
      this.spawnWorker(i);
    }
  }

  getStatus(): WorkerClusterStatus {
    return {
      running: this.running,
      desiredWorkers: this.desiredWorkers,
      liveWorkers: this.workers.size,
      totalRestarts: this.totalRestarts,
    };
  }

  async stop(options?: { readonly force?: boolean }): Promise<void> {
    if (!this.running && this.workers.size === 0) {
      return;
    }
    this.stopping = true;
    this.running = false;

    for (const timer of this.restartTimers) {
      clearTimeout(timer);
    }
    this.restartTimers.clear();

    const entries = [...this.workers.entries()];
    if (options?.force) {
      for (const [, worker] of entries) {
        try {
          worker.terminate();
        } catch {
          // Ignore
        }
      }
      this.workers.clear();
      return;
    }

    await Promise.all(
      entries.map(
        ([, worker]) =>
          new Promise<void>((resolve) => {
            let done = false;
            const finish = () => {
              if (done) return;
              done = true;
              clearTimeout(timer);
              resolve();
            };

            worker.addEventListener("close", finish, { once: true });
            const timer = setTimeout(() => {
              try {
                worker.terminate();
              } catch {
                // Ignore
              }
              finish();
            }, this.shutdownTimeoutMs);
            (timer as { unref?: () => void }).unref?.();

            try {
              worker.postMessage({ type: "cluster:shutdown" });
            } catch {
              try {
                worker.terminate();
              } catch {
                // Ignore
              }
              finish();
            }
          }),
      ),
    );
    this.workers.clear();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.stop();
  }

  private spawnWorker(index: number): void {
    const bunOpts: Bun.WorkerOptions = {
      name: `${this.options.name ?? "bunest-cluster"}-${index}`,
      ref: this.options.ref ?? true,
      env: {
        ...(this.options.env ?? {}),
        BUNEST_CLUSTER_WORKER_INDEX: String(index),
        BUNEST_CLUSTER_WORKERS: String(this.desiredWorkers),
      },
    };
    if (this.options.smol !== undefined) bunOpts.smol = this.options.smol;
    if (this.options.preload !== undefined) {
      bunOpts.preload = Array.isArray(this.options.preload)
        ? [...this.options.preload]
        : (this.options.preload as string);
    }
    if (this.options.argv !== undefined) bunOpts.argv = [...this.options.argv];

    const worker = new Worker(this.options.script, bunOpts);
    this.workers.set(index, worker);

    worker.addEventListener("open", () => {
      this.options.onWorkerReady?.(index);
    });

    worker.addEventListener("error", (event: ErrorEvent) => {
      const err =
        event.error instanceof Error
          ? event.error
          : new Error(event.message || "Cluster worker error");
      this.options.onWorkerError?.(index, err);
    });

    worker.addEventListener("close", (event: Event) => {
      if (this.workers.get(index) === worker) {
        this.workers.delete(index);
      }
      const code = (event as unknown as { code?: unknown }).code;
      const exitCode = typeof code === "number" ? code : undefined;
      this.options.onWorkerExit?.(index, exitCode);

      if (this.stopping || !this.restartOnCrash) {
        return;
      }
      const restarts = this.restartCounts.get(index) ?? 0;
      if (restarts >= this.maxRestarts) {
        return;
      }
      this.restartCounts.set(index, restarts + 1);
      this.totalRestarts += 1;

      const timer = setTimeout(() => {
        this.restartTimers.delete(timer);
        if (!this.stopping) {
          this.spawnWorker(index);
        }
      }, this.restartDelayMs);
      (timer as { unref?: () => void }).unref?.();
      this.restartTimers.add(timer);
    });
  }
}

/**
 * Convenience helper inside a cluster worker script that subscribes to graceful
 * `{ type: "cluster:shutdown" }` messages sent by `BunestWorkerCluster.stop()`.
 */
export function onClusterShutdown(
  handler: () => void | Promise<void>,
): () => void {
  if (isMainThread()) {
    return () => {};
  }
  const listener = (event: MessageEvent) => {
    const data = event.data as { type?: unknown } | null;
    if (data && data.type === "cluster:shutdown") {
      globalThis.removeEventListener("message", listener as EventListener);
      void Promise.resolve(handler()).finally(() => {
        try {
          const maybeClose = (globalThis as unknown as { close?: () => void })
            .close;
          if (typeof maybeClose === "function") {
            maybeClose();
          }
        } catch {
          // Ignore
        }
        const timer = setTimeout(() => {
          try {
            process.exit(0);
          } catch {
            // Ignore
          }
        }, 20);
        (timer as { unref?: () => void }).unref?.();
      });
    }
  };
  globalThis.addEventListener("message", listener as EventListener);
  return () => {
    globalThis.removeEventListener("message", listener as EventListener);
  };
}

export function createWorkerCluster(
  options: WorkerClusterOptions,
): BunestWorkerCluster {
  return new BunestWorkerCluster(options);
}
