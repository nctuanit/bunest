import type {
  ClsServiceLike,
  FactoryProvider,
  ModuleMetadata,
  Provider,
  Scope,
  Type,
} from "@bunest/core";
import type {
  SandboxedQueueWorkerOptions,
  WorkerScriptTarget,
} from "../workers/interfaces";

export type JobStatus =
  "waiting" | "delayed" | "active" | "completed" | "failed" | "dead-letter";

export type QueueEventName =
  "active" | "completed" | "failed" | "stalled" | "dead-letter";

export type BullMQQueueEventName =
  | QueueEventName
  | "added"
  | "cleaned"
  | "deduplicated"
  | "delayed"
  | "drained"
  | "duplicated"
  | "error"
  | "ioredis:close"
  | "paused"
  | "progress"
  | "removed"
  | "resumed"
  | "retries-exhausted"
  | "waiting"
  | "waiting-children"
  | (string & {});

export type BullMQWorkerEventName =
  | QueueEventName
  | "closed"
  | "closing"
  | "drained"
  | "error"
  | "ioredis:close"
  | "paused"
  | "progress"
  | "ready"
  | "resumed"
  | "lockRenewalFailed"
  | "locksRenewed"
  | (string & {});

export interface BackoffOptions {
  readonly type: "fixed" | "exponential";
  readonly delayMs: number;
  readonly maxDelayMs?: number;
  /**
   * Optional randomization factor to avoid thundering-herd retries.
   * `true` applies up to 25% jitter; a number in `[0, 1]` sets the jitter ratio.
   */
  readonly jitter?: boolean | number;
}

export interface BullQueueKeepJobs {
  readonly age?: number;
  readonly count?: number;
}

export interface DefaultJobOptions {
  /**
   * Maximum total execution attempts (including the first attempt).
   * @default 1
   */
  readonly attempts?: number;

  /**
   * Backoff strategy between retry attempts.
   */
  readonly backoff?: BackoffOptions;

  /**
   * Maximum execution time in milliseconds before the job attempt times out.
   */
  readonly timeoutMs?: number;

  /**
   * Remove job payload from the driver store once completed.
   * @default false
   */
  readonly removeOnComplete?: boolean | number | BullQueueKeepJobs;

  /**
   * Remove job payload from the driver store once failed.
   */
  readonly removeOnFail?: boolean | number | BullQueueKeepJobs;

  /**
   * Optional delay in milliseconds before processing (BullMQ compatibility alias for `delayMs`).
   */
  readonly delay?: number;

  /**
   * Default job priority.
   */
  readonly priority?: number;

  /**
   * Optional LIFO flag (BullMQ compatibility).
   */
  readonly lifo?: boolean;

  /**
   * Maximum number of log entries preserved (BullMQ compatibility).
   */
  readonly keepLogs?: number;

  /**
   * Maximum stack trace lines preserved (BullMQ compatibility).
   */
  readonly stackTraceLimit?: number;

  /**
   * Maximum serialized job payload size in bytes (BullMQ compatibility).
   */
  readonly sizeLimit?: number;
}

export interface JobOptions extends DefaultJobOptions {
  /**
   * Explicit job ID. Adding a job with an already-existing ID returns the existing job.
   */
  readonly jobId?: string;

  /**
   * Deduplication key: re-adding a job with the same idempotencyKey returns the existing job.
   */
  readonly idempotencyKey?: string;

  /**
   * Initial delay in milliseconds before the job becomes eligible for processing.
   */
  readonly delayMs?: number;

  /**
   * Priority score (higher numbers execute first; ties break in FIFO order).
   * @default 0
   */
  readonly priority?: number;

  /**
   * Optional pre-populated child job return values for `FlowProducer` parent jobs.
   */
  readonly childrenValues?: Record<string, unknown>;

  /**
   * Optional logical group / tenant key used for per-group concurrency caps
   * and fair round-robin scheduling (`groupConcurrency`).
   */
  readonly groupId?: string;

  /**
   * Multi-tenant alias for `groupId` (applied when `groupId` is omitted).
   */
  readonly tenantId?: string;

  /**
   * Optional JSON-serializable metadata attached to the job. Preserved alongside
   * automatically captured CLS context and ambient W3C `traceparent`.
   */
  readonly metadata?: Record<string, unknown>;
}

export interface GroupConcurrencyConfig {
  /**
   * Default maximum number of concurrently active jobs allowed for any single group/tenant.
   */
  readonly maxPerGroup: number;
  /**
   * Optional per-group active concurrency overrides (e.g. `{ enterprise: 5, free: 1 }`).
   */
  readonly overrides?: Readonly<Record<string, number>>;
}

export type GroupConcurrencyOptions = number | GroupConcurrencyConfig;

export type QueueRateLimiterOptions =
  | {
      /**
       * Maximum number of jobs allowed to start within `durationMs`.
       */
      readonly max: number;
      /**
       * Sliding rate-limit window duration in milliseconds.
       */
      readonly durationMs: number;
      /**
       * Optional BullMQ-compatible alias for `durationMs`.
       */
      readonly duration?: number;
    }
  | {
      /**
       * Maximum number of jobs allowed to start within `duration`.
       */
      readonly max: number;
      /**
       * BullMQ-compatible rate-limit window duration in milliseconds.
       */
      readonly duration: number;
      /**
       * Optional Bunest alias for `duration`.
       */
      readonly durationMs?: number;
    };

export interface QueueDequeueOptions {
  readonly groupConcurrency?: GroupConcurrencyOptions;
  readonly limiter?: QueueRateLimiterOptions;
}

export interface JobEnqueueDiagnosticEvent {
  readonly queue: string;
  readonly jobId: string;
  readonly jobName: string;
  readonly groupId?: string;
  readonly traceparent?: string;
  readonly status: JobStatus;
  readonly delayMs?: number;
  readonly priority?: number;
}

export interface JobProcessDiagnosticEvent {
  readonly phase: "start" | "end" | "error";
  readonly queue: string;
  readonly jobId: string;
  readonly jobName: string;
  readonly groupId?: string;
  readonly traceparent?: string;
  readonly attempt?: number;
  readonly durationMs?: number;
  readonly status: JobStatus;
  readonly error?: unknown;
}

export interface Job<TData = unknown, TResult = unknown> {
  readonly id: string;
  readonly queueName: string;
  readonly name: string;
  readonly data: TData;
  readonly priority: number;
  readonly idempotencyKey?: string;
  readonly groupId?: string;
  readonly metadata?: Record<string, unknown>;
  readonly maxAttempts: number;
  attemptsMade: number;
  status: JobStatus;
  readonly backoff?: BackoffOptions;
  readonly timeoutMs?: number;
  readonly removeOnComplete: boolean;
  readonly createdAt: number;
  processAfter: number;
  startedAt?: number;
  finishedAt?: number;
  returnValue?: TResult;
  failedReason?: string;
  readonly stacktrace: string[];
  leaseToken?: string;
  leaseExpiresAt?: number;
  stalledCount?: number;
  childrenValues?: Record<string, unknown>;
  getChildrenValues?<T = unknown>(): Promise<Record<string, T>>;
}

export interface ReclaimStalledResult<TData = unknown, TResult = unknown> {
  readonly reclaimed: readonly Job<TData, TResult>[];
  readonly deadLettered: readonly Job<TData, TResult>[];
}

export interface BulkJobInput<TData = unknown> {
  readonly name: string;
  readonly data: TData;
  readonly options?: JobOptions;
}

export interface QueueCounts {
  readonly waiting: number;
  readonly delayed: number;
  readonly active: number;
  readonly completed: number;
  readonly failed: number;
  readonly deadLetter: number;
}

/**
 * Pluggable storage and scheduling adapter for `@bunest/jobs/queues`.
 */
export interface QueueDriver {
  enqueue<TData = unknown, TResult = unknown>(
    queueName: string,
    job: Job<TData, TResult>,
  ): Promise<Job<TData, TResult>>;

  dequeue<TData = unknown, TResult = unknown>(
    queueName: string,
    now?: number,
    options?: QueueDequeueOptions,
  ): Promise<Job<TData, TResult> | null>;

  ack<TData = unknown, TResult = unknown>(
    queueName: string,
    jobId: string,
    result?: TResult,
    leaseToken?: string,
  ): Promise<Job<TData, TResult> | null>;

  nack<TData = unknown, TResult = unknown>(
    queueName: string,
    jobId: string,
    error: Error | string,
    retryAt?: number,
    leaseToken?: string,
  ): Promise<Job<TData, TResult> | null>;

  moveToDeadLetter<TData = unknown, TResult = unknown>(
    queueName: string,
    jobId: string,
    error: Error | string,
    leaseToken?: string,
  ): Promise<Job<TData, TResult> | null>;

  getJob<TData = unknown, TResult = unknown>(
    queueName: string,
    jobId: string,
  ): Promise<Job<TData, TResult> | null>;

  getCounts(queueName: string): Promise<QueueCounts>;

  getDeadLetterJobs<TData = unknown, TResult = unknown>(
    queueName: string,
  ): Promise<Job<TData, TResult>[]>;

  retryDeadLetterJob<TData = unknown, TResult = unknown>(
    queueName: string,
    jobId: string,
  ): Promise<Job<TData, TResult> | null>;

  getJobs?<TData = unknown, TResult = unknown>(
    queueName: string,
    status?: JobStatus | "all",
    limit?: number,
    offset?: number,
  ): Promise<Job<TData, TResult>[]>;

  retryJob?<TData = unknown, TResult = unknown>(
    queueName: string,
    jobId: string,
  ): Promise<Job<TData, TResult> | null>;

  getNextDelayedTimestamp?(queueName: string): Promise<number | null>;

  /**
   * Optional hint returning the epoch timestamp (ms) when a rate-limited queue
   * can next dequeue a job, enabling accurate non-spinning timer wakeups.
   */
  getNextRateLimitTimestamp?(
    queueName: string,
    now?: number,
    options?: QueueDequeueOptions,
  ): Promise<number | null>;

  readonly lockDurationMs?: number;

  renewLease?(
    queueName: string,
    jobId: string,
    token: string,
    lockDurationMs?: number,
  ): Promise<boolean>;

  reclaimStalledJobs?(
    queueName?: string,
    now?: number,
  ): Promise<ReclaimStalledResult>;

  onStalled?(
    queueName: string,
    listener: (result: ReclaimStalledResult) => void,
  ): () => void;

  close(): Promise<void> | void;
}

export interface QueueConfig {
  readonly name: string;
  readonly concurrency?: number;
  /**
   * Per-group / per-tenant concurrency cap enabling fair round-robin dequeue
   * across eligible groups to prevent noisy-neighbor starvation.
   */
  readonly groupConcurrency?: GroupConcurrencyOptions;
  /**
   * Sliding-window rate limiter enforced atomically on job dequeue.
   */
  readonly limiter?: QueueRateLimiterOptions;
  /**
   * Optional `ClsService` instance used to capture CLS keys on `add()` / `addBulk()`
   * and restore them around worker job execution.
   */
  readonly clsService?: ClsServiceLike;
  /**
   * Optional override for CLS keys captured during enqueue.
   * Defaults to `DEFAULT_CLS_PROPAGATION_KEYS` (`requestId`, `tenantId`, `userId`, `correlationId`).
   */
  readonly clsKeys?: readonly string[];
  readonly defaultJobOptions?: DefaultJobOptions;
  readonly shutdownTimeoutMs?: number;
  readonly driver?: QueueDriver;
  readonly pollIntervalMs?: number;
}

export interface QueueModuleOptions {
  readonly driver?: QueueDriver;
  readonly defaultJobOptions?: DefaultJobOptions;
  readonly shutdownTimeoutMs?: number;
  readonly clsService?: ClsServiceLike;
  readonly clsKeys?: readonly string[];
  readonly global?: boolean;
}

export interface QueueModuleOptionsFactory {
  createQueueOptions(): Promise<QueueModuleOptions> | QueueModuleOptions;
}

export interface QueueModuleAsyncOptions extends Pick<
  ModuleMetadata,
  "imports"
> {
  readonly global?: boolean;
  readonly useExisting?: Type<QueueModuleOptionsFactory>;
  readonly useClass?: Type<QueueModuleOptionsFactory>;
  readonly useFactory?: (
    ...args: any[]
  ) => Promise<QueueModuleOptions> | QueueModuleOptions;
  readonly inject?: FactoryProvider["inject"];
  readonly extraProviders?: Provider[];
}

export interface QueueConfigFactory {
  createQueueConfig(): Promise<QueueConfig> | QueueConfig;
}

export interface RegisterQueueConfigAsyncOptions extends Pick<
  ModuleMetadata,
  "imports"
> {
  readonly name: string;
  readonly useExisting?: Type<QueueConfigFactory>;
  readonly useClass?: Type<QueueConfigFactory>;
  readonly useFactory?: (
    ...args: any[]
  ) =>
    | Promise<Omit<QueueConfig, "name"> & { name?: string }>
    | (Omit<QueueConfig, "name"> & { name?: string });
  readonly inject?: FactoryProvider["inject"];
  readonly extraProviders?: Provider[];
}

// ---------------------------------------------------------------------------
// BullMQ Structural Adapter Contracts (Zero external `bullmq` dependency)
// ---------------------------------------------------------------------------

/**
 * Structural subset of a BullMQ `Job` instance, allowing real `bullmq` or
 * compatible implementations without requiring `bullmq` as a hard dependency.
 */
export interface BullMQJobLike<TData = unknown, TResult = unknown> {
  readonly id?: string;
  readonly name: string;
  readonly data: TData;
  readonly opts?: {
    readonly jobId?: string;
    readonly priority?: number;
    readonly delay?: number;
    readonly attempts?: number;
    readonly backoff?:
      number | { readonly type: string; readonly delay?: number };
    readonly removeOnComplete?: boolean | number | Record<string, unknown>;
  };
  readonly attemptsMade?: number;
  readonly timestamp?: number;
  readonly processedOn?: number;
  readonly finishedOn?: number;
  readonly returnvalue?: TResult;
  readonly failedReason?: string;
  readonly stacktrace?: string[];
  getState?(): Promise<string>;
  retry?(state?: string): Promise<void>;
  remove?(): Promise<void>;
}

/**
 * Structural subset of a BullMQ `Queue` instance.
 */
export interface BullMQQueueLike<TData = unknown, TResult = unknown> {
  readonly name: string;
  add(
    name: string,
    data: TData,
    opts?: Record<string, unknown>,
  ): Promise<BullMQJobLike<TData, TResult>>;
  addBulk?(
    jobs: ReadonlyArray<{
      readonly name: string;
      readonly data: TData;
      readonly opts?: Record<string, unknown>;
    }>,
  ): Promise<BullMQJobLike<TData, TResult>[]>;
  getJob(
    jobId: string,
  ): Promise<BullMQJobLike<TData, TResult> | null | undefined>;
  getJobCounts?(...types: string[]): Promise<Record<string, number>>;
  getFailed?(
    start?: number,
    end?: number,
  ): Promise<BullMQJobLike<TData, TResult>[]>;
  pause?(): Promise<void>;
  resume?(): Promise<void>;
  close(): Promise<void>;
}

export type BullMQProcessorFn<TData = unknown, TResult = unknown> = (
  job: BullMQJobLike<TData, TResult>,
  token?: string,
) => Promise<TResult> | TResult;

/**
 * Structural subset of a BullMQ `Worker` instance.
 */
export interface BullMQWorkerLike<TData = unknown, TResult = unknown> {
  readonly name?: string;
  on?(event: string, listener: (...args: any[]) => void): unknown;
  off?(event: string, listener: (...args: any[]) => void): unknown;
  pause?(doNotWaitActive?: boolean): Promise<void>;
  resume?(): void;
  waitUntilReady?(): Promise<void>;
  close(force?: boolean): Promise<void>;
}

export interface BullMQQueueFactoryContext {
  readonly connection?: Record<string, unknown>;
  readonly prefix?: string;
  readonly defaultJobOptions?: DefaultJobOptions;
}

export interface BullMQWorkerFactoryContext {
  readonly connection?: Record<string, unknown>;
  readonly prefix?: string;
  readonly concurrency?: number;
  readonly workerOptions?: NestWorkerOptions;
}

export type BullMQQueueFactory<TData = unknown, TResult = unknown> = (
  name: string,
  context: BullMQQueueFactoryContext,
) => BullMQQueueLike<TData, TResult>;

export type BullMQWorkerFactory<TData = unknown, TResult = unknown> = (
  name: string,
  processor: BullMQProcessorFn<TData, TResult>,
  context: BullMQWorkerFactoryContext,
) => BullMQWorkerLike<TData, TResult>;

/**
 * Pluggable backend factory for BullMQ v6+ compatibility.
 */
export type BullMQBackendFactory = (
  name: string,
  opts: unknown,
  options?: unknown,
) => unknown;

export interface BullMQQueueBaseOptions {
  connection?: Record<string, unknown>;
  blockingConnection?: boolean;
  skipVersionCheck?: boolean;
  telemetry?: unknown;
  skipWaitingForReady?: boolean;
}

export interface BullMQStreamsOptions {
  events: {
    maxLen: number;
  };
}

export interface BullMQQueueOptionsBase extends BullMQQueueBaseOptions {
  prefix?: string;
  defaultJobOptions?: DefaultJobOptions;
  streams?: BullMQStreamsOptions;
  skipMetasUpdate?: boolean;
  settings?: Record<string, unknown>;
}

export interface BullMQWorkerOptionsBase extends BullMQQueueBaseOptions {
  prefix?: string;
  name?: string;
  autorun?: boolean;
  concurrency?: number;
  groupConcurrency?: GroupConcurrencyOptions;
  limiter?: QueueRateLimiterOptions;
  metrics?: {
    maxDataPoints: number;
  };
  maximumRateLimitDelay?: number;
  maxStartedAttempts?: number;
  maxStalledCount?: number;
  stalledInterval?: number;
  removeOnComplete?: BullQueueKeepJobs | boolean | number;
  removeOnFail?: BullQueueKeepJobs | boolean | number;
  skipStalledCheck?: boolean;
  skipLockRenewal?: boolean;
  drainDelay?: number;
  lockDuration?: number;
  lockRenewTime?: number;
  runRetryDelay?: number;
  settings?: Record<string, unknown>;
  useWorkerThreads?: boolean;
  workerForkOptions?: Record<string, unknown>;
  workerThreadsOptions?: Record<string, unknown>;
}

export type BullQueueProcessorCallback = (
  job: Job<any, any>,
  token?: string,
) => Promise<unknown> | unknown;

export type BullQueueSeparateProcessor = string | URL;

export interface BullQueueAdvancedProcessor extends BullMQWorkerOptionsBase {
  concurrency?: number;
  callback: BullQueueProcessorCallback;
  backendFactory?: BullMQBackendFactory;
}

export interface BullQueueAdvancedSeparateProcessor extends BullMQWorkerOptionsBase {
  concurrency?: number;
  path: BullQueueSeparateProcessor;
  useWorkerThreads?: boolean;
  backendFactory?: BullMQBackendFactory;
}

export type BullQueueProcessor =
  | BullQueueProcessorCallback
  | BullQueueAdvancedProcessor
  | BullQueueSeparateProcessor
  | BullQueueAdvancedSeparateProcessor;

export interface BullModuleExtraOptions {
  /**
   * When `true`, skips automatic processor/listener registration during `onModuleInit`
   * so the application can invoke `BullRegistrar.register()` manually.
   */
  manualRegistration?: boolean;
}

export interface BullRootModuleOptions extends BullMQQueueOptionsBase {
  extraOptions?: BullModuleExtraOptions;
  backendFactory?: BullMQBackendFactory;
  /** Bunest-native optional driver / adapter hooks */
  readonly driver?: QueueDriver;
  readonly shutdownTimeoutMs?: number;
  readonly clsService?: ClsServiceLike;
  readonly clsKeys?: readonly string[];
  readonly createQueue?: BullMQQueueFactory;
  readonly createWorker?: BullMQWorkerFactory;
  readonly global?: boolean;
}

export interface SharedBullConfigurationFactory {
  createSharedConfiguration():
    Promise<BullRootModuleOptions> | BullRootModuleOptions;
}

export interface SharedBullAsyncConfiguration extends Pick<
  ModuleMetadata,
  "imports"
> {
  useExisting?: Type<SharedBullConfigurationFactory>;
  useClass?: Type<SharedBullConfigurationFactory>;
  useFactory?: (
    ...args: any[]
  ) => Promise<BullRootModuleOptions> | BullRootModuleOptions;
  inject?: FactoryProvider["inject"];
  extraOptions?: BullModuleExtraOptions;
  extraProviders?: Provider[];
}

export interface NestQueueOptions extends BullMQQueueOptionsBase {
  /** @deprecated Not supported in BullMQ v5+ */
  sharedConnection?: boolean;
  backendFactory?: BullMQBackendFactory;
}

export interface NestWorkerOptions extends BullMQWorkerOptionsBase {
  /** @deprecated Not supported in BullMQ v5+ */
  sharedConnection?: boolean;
  backendFactory?: BullMQBackendFactory;
}

export interface NestQueueEventOptions extends BullMQQueueBaseOptions {
  /** @deprecated Not supported in BullMQ v5+ */
  sharedConnection?: boolean;
  telemetry?: unknown;
  backendFactory?: BullMQBackendFactory;
  autorun?: boolean;
  lastEventId?: string;
  blockingTimeout?: number;
  prefix?: string;
}

export type QueueEventsListenerOptions = {
  queueName: string;
  queueEventsOptions?: NestQueueEventOptions;
};

export interface RegisterQueueOptions extends NestQueueOptions {
  name?: string;
  configKey?: string;
  processors?: BullQueueProcessor[];
  forceDisconnectOnShutdown?: boolean;
  /** Bunest-native optional overrides */
  readonly concurrency?: number;
  readonly groupConcurrency?: GroupConcurrencyOptions;
  readonly limiter?: QueueRateLimiterOptions;
  readonly clsService?: ClsServiceLike;
  readonly clsKeys?: readonly string[];
  readonly shutdownTimeoutMs?: number;
  readonly driver?: QueueDriver;
  readonly pollIntervalMs?: number;
  readonly createQueue?: BullMQQueueFactory;
  readonly createWorker?: BullMQWorkerFactory;
}

export interface RegisterQueueOptionsFactory {
  createRegisterQueueOptions():
    Promise<RegisterQueueOptions> | RegisterQueueOptions;
}

export interface RegisterQueueAsyncOptions extends Pick<
  ModuleMetadata,
  "imports"
> {
  name?: string;
  configKey?: string;
  useExisting?: Type<RegisterQueueOptionsFactory>;
  useClass?: Type<RegisterQueueOptionsFactory>;
  useFactory?: (
    ...args: any[]
  ) => Promise<RegisterQueueOptions> | RegisterQueueOptions;
  inject?: FactoryProvider["inject"];
  extraProviders?: Provider[];
}

export interface RegisterFlowProducerOptions extends BullMQQueueBaseOptions {
  name?: string;
  configKey?: string;
  forceDisconnectOnShutdown?: boolean;
  backendFactory?: BullMQBackendFactory;
  prefix?: string;
}

export interface RegisterFlowProducerOptionsFactory {
  createRegisterQueueOptions():
    Promise<RegisterFlowProducerOptions> | RegisterFlowProducerOptions;
}

export interface RegisterFlowProducerAsyncOptions extends Pick<
  ModuleMetadata,
  "imports"
> {
  name?: string;
  configKey?: string;
  useExisting?: Type<RegisterFlowProducerOptionsFactory>;
  useClass?: Type<RegisterFlowProducerOptionsFactory>;
  useFactory?: (
    ...args: any[]
  ) => Promise<RegisterFlowProducerOptions> | RegisterFlowProducerOptions;
  inject?: FactoryProvider["inject"];
}

export interface BullMQModuleOptions extends BullRootModuleOptions {
  readonly createQueue: BullMQQueueFactory;
}

export interface BullMQRegisterQueueOptions extends Omit<
  RegisterQueueOptions,
  "name"
> {
  readonly name: string;
}

// ---------------------------------------------------------------------------
// Decorator Metadata Interfaces
// ---------------------------------------------------------------------------

export interface ProcessorOptions {
  /**
   * Specifies the name of the queue to subscribe to.
   */
  name?: string;
  /**
   * Specifies the DI lifetime scope of an injected Processor.
   */
  scope?: Scope;
  /**
   * Shared configuration key under which the queue/connection configuration is registered.
   */
  configKey?: string;
  /**
   * Optional concurrency override (Bunest shorthand).
   */
  readonly concurrency?: number;
  /**
   * Optional Bun Worker script path/URL to execute queue jobs off the main thread
   * in a dedicated sandboxed `WorkerPool` (Bun-native BullMQ sandboxed processor parity).
   */
  readonly workerFile?: WorkerScriptTarget;
  /**
   * Optional tuning for the sandboxed `WorkerPool` spawned when `workerFile` is set.
   */
  readonly workerPool?: SandboxedQueueWorkerOptions;
}

export interface ProcessorMetadata {
  readonly queueName: string;
  readonly name?: string;
  readonly scope?: Scope;
  readonly configKey?: string;
  readonly concurrency?: number;
  readonly workerOptions?: NestWorkerOptions;
  readonly workerFile?: WorkerScriptTarget;
  readonly workerPool?: SandboxedQueueWorkerOptions;
}

export interface ProcessMethodMetadata {
  readonly methodName: string | symbol;
  readonly jobName?: string;
}

export interface OnQueueEventMetadata {
  eventName: BullMQQueueEventName;
}

export interface OnWorkerEventMetadata {
  eventName: BullMQWorkerEventName;
}

export interface QueueEventMetadata {
  readonly methodName: string | symbol;
  readonly event: BullMQQueueEventName;
  readonly eventName: BullMQQueueEventName;
}

export interface WorkerEventMetadata {
  readonly methodName: string | symbol;
  readonly eventName: BullMQWorkerEventName;
}

// ---------------------------------------------------------------------------
// Handler, Listener & FlowProducer Types
// ---------------------------------------------------------------------------

export type JobHandler<TData = any, TResult = any> = (
  job: Job<TData, TResult>,
  token?: string,
) => Promise<TResult> | TResult;

export type QueueEventListener<TData = any, TResult = any> = (
  job: Job<TData, TResult>,
  payload?: unknown,
) => Promise<void> | void;

export interface FlowJob<TData = unknown> {
  readonly name: string;
  readonly queueName: string;
  readonly data?: TData;
  readonly prefix?: string;
  readonly opts?: JobOptions;
  readonly children?: readonly FlowJob[];
}

export interface FlowJobNode<TData = unknown, TResult = unknown> {
  readonly job: Job<TData, TResult>;
  readonly children?: FlowJobNode[];
}

export interface FlowNodeOpts {
  readonly queueName: string;
  readonly id: string;
  readonly prefix?: string;
  readonly depth?: number;
  readonly maxChildren?: number;
}

export interface FlowOpts {
  readonly queuesOptions?: Record<
    string,
    { defaultJobOptions?: DefaultJobOptions }
  >;
}

export interface QueueEventsLike {
  readonly name?: string;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off?(event: string, listener: (...args: any[]) => void): unknown;
  waitUntilReady?(): Promise<void>;
  close(): Promise<void> | void;
}
