import type {
  ClsContextCarrier,
  ClsServiceLike,
  FactoryProvider,
  ModuleMetadata,
  Provider,
  StandardSchemaV1,
  Type,
} from "@bunest/core";

/**
 * Valid script target accepted by Bun's `new Worker(scriptURL, options)`.
 */
export type WorkerScriptTarget = string | URL;

/**
 * Bun-native `Worker` runtime options (100% Web/Bun globals, zero `node:worker_threads`).
 */
export interface BunWorkerRuntimeOptions {
  /**
   * Enable Bun's `smol` mode (`JSC::HeapSize = Small`) for lower memory usage
   * at the cost of slightly slower throughput.
   * @default false
   */
  readonly smol?: boolean;

  /**
   * Module specifiers preloaded before the worker entrypoint executes
   * (equivalent to `--preload`, e.g. OpenTelemetry/Sentry setup).
   */
  readonly preload?: string | readonly string[];

  /**
   * Custom environment variables passed to the worker thread (`process.env` / `Bun.env`).
   */
  readonly env?: Readonly<Record<string, string>>;

  /**
   * Arguments appended to `Bun.argv` / `process.argv` inside the worker thread.
   */
  readonly argv?: readonly string[];

  /**
   * Whether newly spawned workers start ref'd (`true` keeps the parent process alive).
   * When `unrefWhenIdle` is `true` (default), idle workers are automatically unref'd.
   * @default false
   */
  readonly ref?: boolean;

  /**
   * Optional debug name prefix assigned to `DedicatedWorkerGlobalScope.name`.
   */
  readonly name?: string;
}

/**
 * Configuration for a managed `WorkerPool`.
 */
export interface WorkerPoolOptions extends BunWorkerRuntimeOptions {
  /**
   * Logical name of the pool (used in DI tokens, diagnostics, and health checks).
   * @default "default"
   */
  readonly name?: string;

  /**
   * Worker script path or `URL` (recommended: `new URL("./my.worker.ts", import.meta.url)`).
   */
  readonly script: WorkerScriptTarget;

  /**
   * Minimum number of warm worker threads kept alive.
   * @default 0
   */
  readonly minThreads?: number;

  /**
   * Maximum number of concurrent worker threads in this pool.
   * Defaults to `Math.max(1, getCpuCount() - 1)`.
   */
  readonly maxThreads?: number;

  /**
   * Maximum number of queued tasks waiting for a free worker thread before
   * rejecting with `WorkerPoolSaturatedException` (`BUNEST_E203`).
   * @default 1024
   */
  readonly maxQueueSize?: number;

  /**
   * Default per-task execution timeout in milliseconds (`0` disables timeout).
   * @default 30_000
   */
  readonly taskTimeoutMs?: number;

  /**
   * Maximum time to wait for a newly spawned worker to emit its `READY` handshake.
   * @default 10_000
   */
  readonly startupTimeoutMs?: number;

  /**
   * Idle time in milliseconds before threads above `minThreads` are gracefully retired.
   * Set to `0` to disable idle eviction.
   * @default 30_000
   */
  readonly idleTimeoutMs?: number;

  /**
   * Graceful shutdown timeout in milliseconds before falling back to `worker.terminate()`.
   * @default 5_000
   */
  readonly shutdownTimeoutMs?: number;

  /**
   * Maximum tasks a single worker thread executes before being gracefully recycled
   * when idle (mitigates long-lived JSC heap fragmentation). `0` disables recycling.
   * @default 0
   */
  readonly maxTasksPerWorker?: number;

  /**
   * When `true`, workers are `unref()`'d while idle and `ref()`'d only while executing
   * a task so tests, CLIs, and graceful exits never hang on idle pools.
   * @default true
   */
  readonly unrefWhenIdle?: boolean;

  /**
   * Automatically terminate and replace a worker thread when a task times out
   * (essential for recovering from infinite synchronous CPU loops).
   * @default true
   */
  readonly terminateOnTimeout?: boolean;

  /**
   * Grace period (ms) given to a worker after sending a `CANCEL` frame before
   * forcefully terminating it when `terminateOnAbort` is enabled.
   * @default 100
   */
  readonly cancelGraceMs?: number;

  /**
   * When `true`, eagerly spawns `minThreads` workers during `onModuleInit` / `warmUp()`.
   * @default false
   */
  readonly warmUp?: boolean;

  /**
   * Maximum consecutive worker spawn/crash failures allowed within `crashWindowMs`
   * before pausing automatic respawn of warm threads.
   * @default 5
   */
  readonly maxConsecutiveCrashes?: number;

  /**
   * Static serializable initialization data sent to each worker during the `INIT` handshake
   * (zero-`node:worker_threads` replacement for `setEnvironmentData`).
   */
  readonly initData?: unknown;

  /**
   * Optional `ClsService` instance used to capture CLS keys on `run()` and propagate them
   * across threads.
   */
  readonly clsService?: ClsServiceLike;

  /**
   * Optional override for CLS keys captured during dispatch.
   * Defaults to `DEFAULT_CLS_PROPAGATION_KEYS`.
   */
  readonly clsKeys?: readonly string[];

  /**
   * Optional cleanup callback invoked when `pool.close()` completes
   * (used internally by `createInlineWorkerPool` to revoke `blob:` URLs).
   */
  readonly onDispose?: () => void;
}

/**
 * Shared defaults configured at `WorkerModule.forRoot()`.
 */
export type WorkerPoolDefaults = Omit<
  WorkerPoolOptions,
  "name" | "script" | "onDispose"
>;

/**
 * Per-invocation options for `pool.run(...)`.
 */
export interface WorkerRunOptions {
  /**
   * Per-task execution timeout override in milliseconds (`0` disables timeout).
   */
  readonly timeoutMs?: number;

  /**
   * AbortSignal to cancel a queued or in-flight task.
   */
  readonly signal?: AbortSignal;

  /**
   * Higher numbers execute earlier while queued; equal priorities run FIFO.
   * @default 0
   */
  readonly priority?: number;

  /**
   * Explicit `Bun.Transferable[]` transferred zero-copy to the worker thread.
   */
  readonly transfer?: Bun.Transferable[];

  /**
   * Progress callback invoked whenever the worker calls `ctx.reportProgress(progress)`.
   */
  readonly onProgress?: (progress: unknown) => void;

  /**
   * Override whether to forcefully terminate the worker thread if this task times out.
   */
  readonly terminateOnTimeout?: boolean;

  /**
   * Override whether to forcefully terminate the worker thread if `signal` aborts
   * and the worker does not finish within `cancelGraceMs`.
   * @default false
   */
  readonly terminateOnAbort?: boolean;
}

/**
 * Options for `pool.map(items, task, options)`.
 */
export interface WorkerMapOptions extends Omit<WorkerRunOptions, "transfer"> {
  /**
   * Optional concurrency cap for mapping items across the pool.
   * Defaults to `pool.maxThreads`.
   */
  readonly concurrency?: number;
}

/**
 * Execution context passed to worker task handlers running inside a Bun Worker thread.
 */
export interface WorkerTaskContext {
  readonly taskId: string;
  readonly taskName: string;
  readonly workerId: string;
  readonly signal: AbortSignal;
  readonly initData?: unknown;
  readonly cls?: ClsContextCarrier;
  readonly traceparent?: string;
  reportProgress(progress: unknown): void;
}

/**
 * Function signature of a worker task handler.
 */
export type WorkerTaskHandler<TInput = any, TOutput = any> = (
  payload: TInput,
  ctx: WorkerTaskContext,
) => TOutput | Promise<TOutput>;

/**
 * Map of task names to handlers passed to `defineWorker(...)`.
 */
export type WorkerHandlerMap = Readonly<
  Record<string, WorkerTaskHandler<any, any>>
>;

/**
 * Lifecycle options accepted by `defineWorker(...)`.
 */
export interface DefineWorkerOptions {
  /**
   * Optional async initialization hook executed once after the `INIT` handshake
   * before queued tasks are dispatched.
   */
  readonly onInit?: (initData: unknown) => void | Promise<void>;

  /**
   * Optional async cleanup hook executed during graceful `SHUTDOWN` before exiting.
   */
  readonly onShutdown?: (reason?: string) => void | Promise<void>;

  /**
   * Optional listener for messages sent via `pool.broadcast(event, payload)`.
   */
  readonly onBroadcast?: (event: string, payload: unknown) => void | Promise<void>;

  /**
   * Optional `ClsService` instance used to restore propagated CLS context around
   * each task execution inside the worker thread.
   */
  readonly clsService?: ClsServiceLike;
}

/**
 * Lifecycle state of an individual worker slot.
 */
export type WorkerSlotState =
  | "starting"
  | "idle"
  | "busy"
  | "draining"
  | "closed";

/**
 * Point-in-time operational statistics of a `WorkerPool`.
 */
export interface WorkerPoolStats {
  readonly name: string;
  readonly closed: boolean;
  readonly minThreads: number;
  readonly maxThreads: number;
  readonly activeWorkers: number;
  readonly idleWorkers: number;
  readonly startingWorkers: number;
  readonly totalWorkers: number;
  readonly queuedTasks: number;
  readonly maxQueueSize: number;
  readonly completedTasks: number;
  readonly failedTasks: number;
  readonly timedOutTasks: number;
  readonly cancelledTasks: number;
  readonly workersSpawned: number;
  readonly workersRecycled: number;
  readonly workersCrashed: number;
  readonly consecutiveCrashes: number;
}

/**
 * Structural health snapshot consumed by `@bunest/observability`'s `WorkerPoolHealthIndicator`
 * without creating any cross-package coupling.
 */
export interface WorkerPoolHealthSnapshot {
  readonly name: string;
  readonly healthy: boolean;
  readonly closed: boolean;
  readonly totalWorkers: number;
  readonly activeWorkers: number;
  readonly idleWorkers: number;
  readonly queuedTasks: number;
  readonly maxQueueSize: number;
  readonly maxThreads: number;
  readonly consecutiveCrashes: number;
  readonly queueUtilization: number;
}

/**
 * Structural interface matching a `WorkerPool` (used for testing mocks & health indicators).
 */
export interface WorkerPoolLike {
  readonly name: string;
  run<TInput = unknown, TOutput = unknown>(
    taskOrContract: string | WorkerContractLike<string, TInput, TOutput>,
    payload: TInput,
    options?: WorkerRunOptions,
  ): Promise<TOutput>;
  getStats(): WorkerPoolStats;
  getHealthSnapshot(): WorkerPoolHealthSnapshot;
  close(options?: { readonly force?: boolean; readonly timeoutMs?: number }): Promise<void>;
}

/**
 * Structural contract marker shape for `WorkerContract`.
 */
export interface WorkerContractLike<
  TName extends string = string,
  TInput = unknown,
  TOutput = unknown,
> {
  readonly name: TName;
  readonly inputSchema?: StandardSchemaV1<any, TInput>;
  readonly outputSchema?: StandardSchemaV1<any, TOutput>;
  readonly defaultOptions?: WorkerRunOptions;
  readonly __input?: TInput;
  readonly __output?: TOutput;
}

/**
 * Diagnostics event payload emitted on `bunest:workers:dispatch`.
 */
export interface WorkerDispatchDiagnosticEvent {
  readonly phase: "start" | "end" | "error";
  readonly pool: string;
  readonly task: string;
  readonly taskId: string;
  readonly workerId?: string;
  readonly queueWaitMs?: number;
  readonly durationMs?: number;
  readonly status?: "completed" | "failed" | "timeout" | "aborted" | "saturated";
  readonly traceparent?: string;
  readonly error?: unknown;
}

/**
 * Diagnostics event payload emitted on `bunest:workers:lifecycle`.
 */
export interface WorkerLifecycleDiagnosticEvent {
  readonly event: "spawn" | "ready" | "crash" | "recycle" | "evict" | "close";
  readonly pool: string;
  readonly workerId: string;
  readonly exitCode?: number;
  readonly tasksExecuted?: number;
  readonly error?: unknown;
}

/**
 * Root configuration for `WorkerModule.forRoot(...)`.
 */
export interface WorkerModuleOptions {
  /**
   * Default options merged into every pool registered via `WorkerModule.registerPool(...)`.
   */
  readonly defaultPoolOptions?: WorkerPoolDefaults;

  /**
   * Optional pools registered inline alongside `forRoot(...)`.
   */
  readonly pools?: readonly WorkerPoolOptions[];

  /**
   * Register `WorkerModule` globally.
   * @default true
   */
  readonly global?: boolean;
}

export interface WorkerModuleOptionsFactory {
  createWorkerModuleOptions():
    | Promise<WorkerModuleOptions>
    | WorkerModuleOptions;
}

export interface WorkerModuleAsyncOptions
  extends Pick<ModuleMetadata, "imports"> {
  readonly global?: boolean;
  readonly useExisting?: Type<WorkerModuleOptionsFactory>;
  readonly useClass?: Type<WorkerModuleOptionsFactory>;
  readonly useFactory?: (
    ...args: any[]
  ) => Promise<WorkerModuleOptions> | WorkerModuleOptions;
  readonly inject?: FactoryProvider["inject"];
  readonly extraProviders?: Provider[];
}

export interface RegisterWorkerPoolOptionsFactory {
  createWorkerPoolOptions():
    | Promise<WorkerPoolOptions>
    | WorkerPoolOptions;
}

export interface RegisterWorkerPoolAsyncOptions
  extends Pick<ModuleMetadata, "imports"> {
  readonly name: string;
  readonly useExisting?: Type<RegisterWorkerPoolOptionsFactory>;
  readonly useClass?: Type<RegisterWorkerPoolOptionsFactory>;
  readonly useFactory?: (
    ...args: any[]
  ) => Promise<Omit<WorkerPoolOptions, "name">> | Omit<WorkerPoolOptions, "name">;
  readonly inject?: FactoryProvider["inject"];
  readonly extraProviders?: Provider[];
}

/**
 * Metadata recorded by `@WorkerHandler(nameOrContract)` inside DI-enabled workers.
 */
export interface WorkerHandlerMetadata {
  readonly taskName: string;
  readonly methodName: string | symbol;
  readonly contract?: WorkerContractLike<any, any, any>;
}

/**
 * Options for the declarative `@Offload(...)` AOP method decorator.
 */
export interface OffloadOptions {
  /**
   * Registered worker pool name (defaults to `"default"`).
   */
  readonly pool?: string;

  /**
   * Task name inside the worker (defaults to the decorated method name).
   */
  readonly task?: string;

  /**
   * Optional typed worker contract (overrides `task` and enables schema validation).
   */
  readonly contract?: WorkerContractLike<any, any, any>;

  /**
   * Maps method invocation arguments into the worker task payload.
   * Defaults to: 0 args → `undefined`, 1 arg → `args[0]`, 2+ args → `args`.
   */
  readonly mapArgs?: (...args: any[]) => unknown;

  /**
   * Optional transfer list extractor evaluated per call.
   */
  readonly extractTransfer?: (payload: unknown, args: readonly unknown[]) => Bun.Transferable[];

  /**
   * Optional per-call timeout override (ms).
   */
  readonly timeoutMs?: number;

  /**
   * Optional priority override.
   */
  readonly priority?: number;

  /**
   * Fallback to executing the local method on the main thread when the pool
   * is not registered (useful in unit tests without `WorkerModule`).
   * @default false
   */
  readonly fallbackToLocal?: boolean;
}

/**
 * Options for `createInlineWorkerPool(...)`.
 */
export interface InlineWorkerPoolOptions
  extends Omit<WorkerPoolOptions, "script" | "onDispose"> {
  /**
   * When `true`, `source` is treated as raw TypeScript/JavaScript worker code
   * rather than wrapped automatically in a single-handler runner.
   * @default false
   */
  readonly rawScript?: boolean;

  /**
   * Virtual filename given to the `File` backing the `blob:` URL (controls Bun loader).
   * @default "inline-worker.ts"
   */
  readonly filename?: string;
}

/**
 * Sandboxed worker options attached to `@Processor(queueName, ...)` in `@bunest/jobs/queues`.
 */
export interface SandboxedQueueWorkerOptions
  extends Omit<WorkerPoolOptions, "name" | "script" | "onDispose"> {
  /**
   * Task name dispatched inside the worker script.
   * Defaults to `job.name` (falling back to `"default"` if the worker only exports a default handler).
   */
  readonly taskName?: string;
}
