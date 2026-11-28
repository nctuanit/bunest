import {
  WorkerSpawnException,
  WorkerTerminatedException,
} from "./errors";
import type {
  BunWorkerRuntimeOptions,
  WorkerScriptTarget,
  WorkerSlotState,
} from "./interfaces";
import {
  WORKER_PROTOCOL_VERSION,
  deserializeWorkerError,
  isWorkerProtocolFrame,
  type MainToWorkerFrame,
  type WorkerToMainFrame,
} from "./protocol";

export interface WorkerSlotCallbacks {
  readonly onReady?: (slot: WorkerSlot, tasks: readonly string[]) => void;
  readonly onIdle?: (slot: WorkerSlot) => void;
  readonly onCrash?: (
    slot: WorkerSlot,
    error: Error,
    exitCode?: number,
  ) => void;
  readonly onClose?: (slot: WorkerSlot, exitCode?: number) => void;
}

export interface ActiveSlotTask {
  readonly id: string;
  readonly taskName: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (err: Error) => void;
  readonly onProgress?: (progress: unknown) => void;
}

export interface WorkerSlotConfig extends BunWorkerRuntimeOptions {
  readonly workerId: string;
  readonly poolName: string;
  readonly script: WorkerScriptTarget;
  readonly startupTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly unrefWhenIdle: boolean;
  readonly initData?: unknown;
}

function toBunWorkerOptions(config: WorkerSlotConfig): Bun.WorkerOptions {
  const opts: Bun.WorkerOptions = {
    name: config.name ? `${config.name}:${config.workerId}` : config.workerId,
    ref: config.unrefWhenIdle ? false : (config.ref ?? false),
  };
  if (config.smol !== undefined) {
    opts.smol = config.smol;
  }
  if (config.preload !== undefined) {
    opts.preload = Array.isArray(config.preload)
      ? [...config.preload]
      : (config.preload as string);
  }
  if (config.env !== undefined) {
    opts.env = { ...config.env };
  }
  if (config.argv !== undefined) {
    opts.argv = [...config.argv];
  }
  return opts;
}

/**
 * Manages a single Bun `Worker` thread lifecycle, protocol framing, ref/unref
 * switching, and two-phase graceful shutdown with forced `terminate()` fallback.
 */
export class WorkerSlot {
  readonly workerId: string;
  private readonly worker: Worker;
  private readonly config: WorkerSlotConfig;
  private readonly callbacks: WorkerSlotCallbacks;

  private _state: WorkerSlotState = "starting";
  private _tasksExecuted = 0;
  private _lastUsedAt = Date.now();
  private _registeredTasks: readonly string[] = [];
  private activeTask?: ActiveSlotTask;
  private pendingPings = new Map<string, () => void>();
  private shutdownPromise?: Promise<void>;
  private closeResolvers: Array<() => void> = [];
  private startupTimer?: ReturnType<typeof setTimeout>;
  private readyResolve?: () => void;
  private readyReject?: (err: Error) => void;
  readonly readyPromise: Promise<void>;
  private isRefd: boolean;
  private intentionalClose = false;

  constructor(config: WorkerSlotConfig, callbacks: WorkerSlotCallbacks = {}) {
    this.workerId = config.workerId;
    this.config = config;
    this.callbacks = callbacks;
    this.isRefd = !config.unrefWhenIdle && (config.ref ?? false);

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    // Prevent unhandled rejection warnings when callers observe crash via callbacks
    this.readyPromise.catch(() => undefined);

    const bunOpts = toBunWorkerOptions(config);
    try {
      this.worker = new Worker(config.script, bunOpts);
    } catch (err) {
      const spawnErr = new WorkerSpawnException(
        `Failed to spawn worker "${config.workerId}" in pool "${config.poolName}" from "${String(config.script)}": ${err instanceof Error ? err.message : String(err)}`,
        {
          cause: err,
          details: {
            poolName: config.poolName,
            workerId: config.workerId,
            script: String(config.script),
          },
        },
      );
      this._state = "closed";
      this.readyReject?.(spawnErr);
      throw spawnErr;
    }

    this.attachListeners();
    this.startHandshake();
  }

  get state(): WorkerSlotState {
    return this._state;
  }

  get tasksExecuted(): number {
    return this._tasksExecuted;
  }

  get lastUsedAt(): number {
    return this._lastUsedAt;
  }

  get registeredTasks(): readonly string[] {
    return this._registeredTasks;
  }

  get currentTaskId(): string | undefined {
    return this.activeTask?.id;
  }

  private setRef(shouldRef: boolean): void {
    if (this._state === "closed" || this.isRefd === shouldRef) {
      return;
    }
    this.isRefd = shouldRef;
    try {
      if (shouldRef) {
        this.worker.ref();
      } else {
        this.worker.unref();
      }
    } catch {
      // Worker may already be terminating
    }
  }

  private attachListeners(): void {
    this.worker.addEventListener("message", (event: MessageEvent) => {
      this.handleMessage(event.data);
    });

    this.worker.addEventListener("messageerror", () => {
      const err = new WorkerTerminatedException(
        `Worker "${this.workerId}" in pool "${this.config.poolName}" failed to deserialize a message.`,
        {
          details: { poolName: this.config.poolName, workerId: this.workerId },
        },
      );
      this.failActiveTask(err);
    });

    this.worker.addEventListener("error", (event: ErrorEvent) => {
      const msg =
        event.message ||
        (event.error instanceof Error ? event.error.message : "Unknown worker error");
      const err =
        this._state === "starting"
          ? new WorkerSpawnException(
              `Worker "${this.workerId}" in pool "${this.config.poolName}" errored during startup: ${msg}`,
              {
                cause: event.error,
                details: {
                  poolName: this.config.poolName,
                  workerId: this.workerId,
                  script: String(this.config.script),
                },
              },
            )
          : new WorkerTerminatedException(
              `Worker "${this.workerId}" in pool "${this.config.poolName}" encountered an uncaught error: ${msg}`,
              {
                cause: event.error,
                details: {
                  poolName: this.config.poolName,
                  workerId: this.workerId,
                },
              },
            );

      this.handleFatalFailure(err);
    });

    this.worker.addEventListener("close", (event: Event) => {
      const code = (event as unknown as { code?: unknown }).code;
      const exitCode = typeof code === "number" ? code : undefined;
      this.handleClosed(exitCode);
    });
  }

  private startHandshake(): void {
    this.startupTimer = setTimeout(() => {
      if (this._state !== "starting") {
        return;
      }
      const err = new WorkerSpawnException(
        `Worker "${this.workerId}" in pool "${this.config.poolName}" did not emit READY within ${this.config.startupTimeoutMs}ms.`,
        {
          details: {
            poolName: this.config.poolName,
            workerId: this.workerId,
            script: String(this.config.script),
            startupTimeoutMs: this.config.startupTimeoutMs,
          },
        },
      );
      this.handleFatalFailure(err);
    }, this.config.startupTimeoutMs);
    (this.startupTimer as { unref?: () => void }).unref?.();

    const initFrame: MainToWorkerFrame = {
      __bw: WORKER_PROTOCOL_VERSION,
      t: "init",
      workerId: this.workerId,
      ...(this.config.initData !== undefined
        ? { initData: this.config.initData }
        : {}),
    };

    try {
      this.worker.postMessage(initFrame);
    } catch (err) {
      const spawnErr = new WorkerSpawnException(
        `Failed to send INIT frame to worker "${this.workerId}": ${err instanceof Error ? err.message : String(err)}`,
        {
          cause: err,
          details: { poolName: this.config.poolName, workerId: this.workerId },
        },
      );
      this.handleFatalFailure(spawnErr);
    }
  }

  private clearStartupTimer(): void {
    if (this.startupTimer !== undefined) {
      clearTimeout(this.startupTimer);
      this.startupTimer = undefined;
    }
  }

  private handleMessage(raw: unknown): void {
    if (!isWorkerProtocolFrame(raw)) {
      return;
    }
    const frame = raw as WorkerToMainFrame;

    switch (frame.t) {
      case "ready": {
        if (this._state !== "starting") {
          return;
        }
        this.clearStartupTimer();
        this._registeredTasks = frame.tasks;
        this._state = "idle";
        this._lastUsedAt = Date.now();
        if (this.config.unrefWhenIdle) {
          this.setRef(false);
        }
        this.readyResolve?.();
        this.readyResolve = undefined;
        this.readyReject = undefined;
        this.callbacks.onReady?.(this, frame.tasks);
        return;
      }

      case "result": {
        const task = this.activeTask;
        if (!task || task.id !== frame.id) {
          return;
        }
        this.activeTask = undefined;
        this._tasksExecuted += 1;
        this._lastUsedAt = Date.now();
        if (this._state === "busy") {
          this._state = "idle";
        }
        if (this.config.unrefWhenIdle) {
          this.setRef(false);
        }
        task.resolve(frame.value);
        if (this._state === "idle") {
          this.callbacks.onIdle?.(this);
        }
        return;
      }

      case "error": {
        const reconstructed = deserializeWorkerError(frame.error);
        if (frame.id === "__init__") {
          const spawnErr = new WorkerSpawnException(
            `Worker "${this.workerId}" in pool "${this.config.poolName}" failed initialization: ${reconstructed.message}`,
            {
              cause: reconstructed,
              details: {
                poolName: this.config.poolName,
                workerId: this.workerId,
              },
            },
          );
          this.handleFatalFailure(spawnErr);
          return;
        }
        const task = this.activeTask;
        if (!task || task.id !== frame.id) {
          return;
        }
        this.activeTask = undefined;
        this._tasksExecuted += 1;
        this._lastUsedAt = Date.now();
        if (this._state === "busy") {
          this._state = "idle";
        }
        if (this.config.unrefWhenIdle) {
          this.setRef(false);
        }
        task.reject(reconstructed);
        if (this._state === "idle") {
          this.callbacks.onIdle?.(this);
        }
        return;
      }

      case "progress": {
        const task = this.activeTask;
        if (task && task.id === frame.id && task.onProgress) {
          try {
            task.onProgress(frame.progress);
          } catch {
            // Do not crash worker slot if user progress listener throws
          }
        }
        return;
      }

      case "pong": {
        const resolver = this.pendingPings.get(frame.id);
        if (resolver) {
          this.pendingPings.delete(frame.id);
          resolver();
        }
        return;
      }

      case "shutdown_ack": {
        // Worker acknowledged graceful shutdown and is closing itself
        return;
      }
    }
  }

  private failActiveTask(err: Error): void {
    const task = this.activeTask;
    if (!task) {
      return;
    }
    this.activeTask = undefined;
    task.reject(err);
  }

  private handleFatalFailure(err: Error, exitCode?: number): void {
    if (this._state === "closed") {
      return;
    }
    this.clearStartupTimer();
    const wasIntentional = this.intentionalClose;
    this._state = "closed";

    const rejectReady = this.readyReject;
    this.readyResolve = undefined;
    this.readyReject = undefined;
    rejectReady?.(err);

    this.failActiveTask(err);
    this.resolvePendingClose();

    try {
      this.worker.terminate();
    } catch {
      // Ignore already-terminated errors
    }

    if (!wasIntentional) {
      this.callbacks.onCrash?.(this, err, exitCode);
    }
    this.callbacks.onClose?.(this, exitCode);
  }

  private handleClosed(exitCode?: number): void {
    if (this._state === "closed") {
      this.resolvePendingClose();
      return;
    }
    this.clearStartupTimer();
    const wasIntentional = this.intentionalClose;
    const wasStarting = this._state === "starting";
    this._state = "closed";

    const err = wasStarting
      ? new WorkerSpawnException(
          `Worker "${this.workerId}" in pool "${this.config.poolName}" exited during startup (exitCode=${exitCode ?? 0}).`,
          {
            details: {
              poolName: this.config.poolName,
              workerId: this.workerId,
              exitCode: exitCode ?? 0,
            },
          },
        )
      : new WorkerTerminatedException(
          `Worker "${this.workerId}" in pool "${this.config.poolName}" closed unexpectedly (exitCode=${exitCode ?? 0}).`,
          {
            exitCode,
            details: {
              poolName: this.config.poolName,
              workerId: this.workerId,
            },
          },
        );

    const rejectReady = this.readyReject;
    this.readyResolve = undefined;
    this.readyReject = undefined;
    rejectReady?.(err);

    this.failActiveTask(err);
    this.resolvePendingClose();

    if (!wasIntentional) {
      this.callbacks.onCrash?.(this, err, exitCode);
    }
    this.callbacks.onClose?.(this, exitCode);
  }

  private resolvePendingClose(): void {
    for (const resolve of this.closeResolvers.splice(0)) {
      resolve();
    }
    for (const resolve of this.pendingPings.values()) {
      resolve();
    }
    this.pendingPings.clear();
  }

  dispatch(
    frame: Extract<MainToWorkerFrame, { t: "task" }>,
    task: ActiveSlotTask,
    transfer?: Bun.Transferable[],
  ): void {
    if (this._state !== "idle") {
      throw new WorkerTerminatedException(
        `Cannot dispatch task "${frame.task}" to worker "${this.workerId}" in state "${this._state}".`,
      );
    }

    this._state = "busy";
    this.activeTask = task;
    if (this.config.unrefWhenIdle) {
      this.setRef(true);
    }

    try {
      if (transfer && transfer.length > 0) {
        this.worker.postMessage(frame, transfer);
      } else {
        this.worker.postMessage(frame);
      }
    } catch (err) {
      this.activeTask = undefined;
      this._state = "idle";
      if (this.config.unrefWhenIdle) {
        this.setRef(false);
      }
      task.reject(err instanceof Error ? err : new Error(String(err)));
      this.callbacks.onIdle?.(this);
    }
  }

  sendCancel(taskId: string, reason?: string): void {
    if (this._state === "closed") {
      return;
    }
    try {
      const frame: MainToWorkerFrame = {
        __bw: WORKER_PROTOCOL_VERSION,
        t: "cancel",
        id: taskId,
        ...(reason ? { reason } : {}),
      };
      this.worker.postMessage(frame);
    } catch {
      // Ignore if channel already closed
    }
  }

  sendBroadcast(
    event: string,
    payload: unknown,
    transfer?: Bun.Transferable[],
  ): void {
    if (this._state === "closed" || this._state === "draining") {
      return;
    }
    try {
      const frame: MainToWorkerFrame = {
        __bw: WORKER_PROTOCOL_VERSION,
        t: "broadcast",
        event,
        payload,
      };
      if (transfer && transfer.length > 0) {
        this.worker.postMessage(frame, transfer);
      } else {
        this.worker.postMessage(frame);
      }
    } catch {
      // Best-effort broadcast
    }
  }

  /**
   * Two-phase shutdown:
   * 1. Send `SHUTDOWN` frame so worker drains & calls `self.close()` gracefully.
   * 2. If `"close"` does not fire within `timeoutMs`, fall back to `worker.terminate()`.
   */
  close(options?: {
    readonly force?: boolean;
    readonly timeoutMs?: number;
    readonly reason?: string;
  }): Promise<void> {
    if (this._state === "closed") {
      return Promise.resolve();
    }
    if (this.shutdownPromise && !options?.force) {
      return this.shutdownPromise;
    }

    this.intentionalClose = true;
    const force = options?.force === true;
    const timeoutMs = Math.max(
      0,
      options?.timeoutMs ?? this.config.shutdownTimeoutMs,
    );

    if (force) {
      this.forceTerminate(
        options?.reason ?? "Worker forcefully terminated.",
      );
      return Promise.resolve();
    }

    this._state = "draining";

    this.shutdownPromise = new Promise<void>((resolve) => {
      if (this._state === "closed") {
        resolve();
        return;
      }

      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve();
      };

      this.closeResolvers.push(done);

      const timer = setTimeout(() => {
        if (this._state !== "closed") {
          this.forceTerminate(
            `Worker "${this.workerId}" exceeded graceful shutdown timeout (${timeoutMs}ms).`,
          );
        }
        done();
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();

      try {
        const frame: MainToWorkerFrame = {
          __bw: WORKER_PROTOCOL_VERSION,
          t: "shutdown",
          ...(options?.reason ? { reason: options.reason } : {}),
        };
        this.worker.postMessage(frame);
      } catch {
        this.forceTerminate("Failed to send SHUTDOWN frame.");
        done();
      }
    });

    return this.shutdownPromise;
  }

  forceTerminate(reason = "Worker forcefully terminated."): void {
    if (this._state === "closed") {
      return;
    }
    this.intentionalClose = true;
    this.clearStartupTimer();
    this._state = "closed";

    const err = new WorkerTerminatedException(reason, {
      details: { poolName: this.config.poolName, workerId: this.workerId },
    });

    const rejectReady = this.readyReject;
    this.readyResolve = undefined;
    this.readyReject = undefined;
    rejectReady?.(err);

    this.failActiveTask(err);
    try {
      this.worker.terminate();
    } catch {
      // Ignore
    }
    this.resolvePendingClose();
    this.callbacks.onClose?.(this);
  }
}
