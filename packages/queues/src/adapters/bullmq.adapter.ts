import {
  Global,
  Inject,
  Injectable,
  MetadataRegistry,
  Module,
  Optional,
  REQUEST,
  Scope,
  type DynamicModule,
  type ModuleExport,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
  type Provider,
  type Type,
} from "@bunest/common";
import {
  ContextIdFactory,
  DiscoveryService,
  ModuleRef,
  type InstanceWrapper,
} from "@bunest/core";
import { MemoryQueueDriver } from "../drivers/memory.driver";
import { FlowProducer } from "../flow-producer";
import { QueueEvents, QueueEventsHost } from "../hosts/queue-events-host.class";
import { WorkerHost } from "../hosts/worker-host.class";
import { ProcessorDecoratorService } from "../instrument/processor-decorator.service";
import type {
  BackoffOptions,
  BullMQJobLike,
  BullMQModuleOptions,
  BullMQProcessorFn,
  BullMQQueueFactory,
  BullMQQueueFactoryContext,
  BullMQQueueLike,
  BullMQRegisterQueueOptions,
  BullMQWorkerFactory,
  BullMQWorkerFactoryContext,
  BullMQWorkerLike,
  BullModuleExtraOptions,
  BullQueueAdvancedProcessor,
  BullQueueProcessor,
  BullRootModuleOptions,
  Job,
  JobHandler,
  JobStatus,
  NestWorkerOptions,
  ProcessMethodMetadata,
  ProcessorMetadata,
  QueueCounts,
  QueueDriver,
  QueueEventMetadata,
  QueueEventName,
  QueueEventsListenerOptions,
  RegisterFlowProducerAsyncOptions,
  RegisterFlowProducerOptions,
  RegisterFlowProducerOptionsFactory,
  RegisterQueueAsyncOptions,
  RegisterQueueOptions,
  RegisterQueueOptionsFactory,
  SharedBullAsyncConfiguration,
  SharedBullConfigurationFactory,
  WorkerEventMetadata,
} from "../interfaces";
import { Queue } from "../queue";
import { QueueRegistry } from "../queue.module";
import {
  BULLMQ_DRIVER,
  BULLMQ_MODULE_OPTIONS,
  BULL_EXTRA_OPTIONS_TOKEN,
  JOB_REF,
  QUEUE_DRIVER,
  QUEUE_EVENTS_LISTENER_METADATA,
  QUEUE_EVENT_METADATA,
  QUEUE_MODULE_OPTIONS,
  QUEUE_PROCESSOR_METADATA,
  QUEUE_PROCESS_METADATA,
  QUEUE_REGISTRY,
  QUEUE_WORKER_EVENT_METADATA,
  getFlowProducerOptionsToken,
  getFlowProducerToken,
  getQueueOptionsToken,
  getQueueToken,
  getSharedConfigToken,
} from "../tokens";

export type {
  BullMQJobLike,
  BullMQModuleOptions,
  BullMQProcessorFn,
  BullMQQueueFactory,
  BullMQQueueFactoryContext,
  BullMQQueueLike,
  BullMQRegisterQueueOptions,
  BullMQWorkerFactory,
  BullMQWorkerFactoryContext,
  BullMQWorkerLike,
};

function mapBullState(
  state: string | undefined,
  bullJob: BullMQJobLike,
): JobStatus {
  switch (state) {
    case "waiting":
    case "prioritized":
    case "waiting-children":
      return "waiting";
    case "delayed":
      return "delayed";
    case "active":
      return "active";
    case "completed":
      return "completed";
    case "failed":
      return "dead-letter";
    default:
      if (bullJob.failedReason) return "dead-letter";
      if (bullJob.finishedOn !== undefined) return "completed";
      if (bullJob.processedOn !== undefined) return "active";
      if ((bullJob.opts?.delay ?? 0) > 0) return "delayed";
      return "waiting";
  }
}

function mapBullBackoff(
  backoff: NonNullable<BullMQJobLike["opts"]>["backoff"],
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

async function normalizeBullJob<TData, TResult>(
  queueName: string,
  bullJob: BullMQJobLike<TData, TResult>,
  statusOverride?: JobStatus,
): Promise<Job<TData, TResult>> {
  const rawState =
    statusOverride === undefined && typeof bullJob.getState === "function"
      ? await bullJob.getState()
      : undefined;
  const createdAt = bullJob.timestamp ?? Date.now();
  const delay = Math.max(0, bullJob.opts?.delay ?? 0);

  return {
    id: String(bullJob.id ?? bullJob.opts?.jobId ?? ""),
    queueName,
    name: bullJob.name,
    data: bullJob.data,
    priority: bullJob.opts?.priority ?? 0,
    maxAttempts: Math.max(1, bullJob.opts?.attempts ?? 1),
    attemptsMade: bullJob.attemptsMade ?? 0,
    status: statusOverride ?? mapBullState(rawState, bullJob),
    backoff: mapBullBackoff(bullJob.opts?.backoff),
    removeOnComplete: Boolean(bullJob.opts?.removeOnComplete),
    createdAt,
    processAfter: createdAt + delay,
    startedAt: bullJob.processedOn,
    finishedAt: bullJob.finishedOn,
    returnValue: bullJob.returnvalue,
    failedReason: bullJob.failedReason,
    stacktrace: Array.isArray(bullJob.stacktrace) ? [...bullJob.stacktrace] : [],
  };
}

function normalizeBullJobSync<TData, TResult>(
  queueName: string,
  bullJob: BullMQJobLike<TData, TResult>,
  statusOverride?: JobStatus,
): Job<TData, TResult> {
  const createdAt = bullJob.timestamp ?? Date.now();
  const delay = Math.max(0, bullJob.opts?.delay ?? 0);

  return {
    id: String(bullJob.id ?? bullJob.opts?.jobId ?? ""),
    queueName,
    name: bullJob.name,
    data: bullJob.data,
    priority: bullJob.opts?.priority ?? 0,
    maxAttempts: Math.max(1, bullJob.opts?.attempts ?? 1),
    attemptsMade: bullJob.attemptsMade ?? 0,
    status: statusOverride ?? mapBullState(undefined, bullJob),
    backoff: mapBullBackoff(bullJob.opts?.backoff),
    removeOnComplete: Boolean(bullJob.opts?.removeOnComplete),
    createdAt,
    processAfter: createdAt + delay,
    startedAt: bullJob.processedOn,
    finishedAt: bullJob.finishedOn,
    returnValue: bullJob.returnvalue,
    failedReason: bullJob.failedReason,
    stacktrace: Array.isArray(bullJob.stacktrace) ? [...bullJob.stacktrace] : [],
  };
}

function collectMergedClassArray<T>(key: symbol, target: Function): T[] {
  const chain: Function[] = [];
  let cursor: Function | null = target;
  while (cursor && cursor !== Function.prototype && cursor !== Object) {
    chain.push(cursor);
    const parent = Object.getPrototypeOf(cursor);
    cursor = typeof parent === "function" ? parent : null;
  }
  chain.reverse();

  const merged: T[] = [];
  for (const ctor of chain) {
    const own = MetadataRegistry.getOwn<readonly T[]>(key, ctor);
    if (own) {
      merged.push(...own);
    }
  }
  return merged;
}

function getAllLoadedWrappers(
  discoveryService: DiscoveryService | undefined,
): InstanceWrapper[] {
  if (!discoveryService) {
    return [];
  }
  const seen = new Set<InstanceWrapper>();
  const wrappers: InstanceWrapper[] = [];
  for (const wrapper of [
    ...discoveryService.getProviders(),
    ...discoveryService.getControllers(),
  ]) {
    if (!seen.has(wrapper)) {
      seen.add(wrapper);
      wrappers.push(wrapper);
    }
  }
  return wrappers;
}

function resolveWrapperMetatype(wrapper: InstanceWrapper): Function | undefined {
  if (wrapper.instance && typeof wrapper.instance === "object") {
    const ctor = (wrapper.instance as { constructor?: Function }).constructor;
    if (typeof ctor === "function") {
      return ctor;
    }
  }
  return typeof wrapper.metatype === "function" ? wrapper.metatype : undefined;
}

function isAdvancedProcessor(
  proc: BullQueueProcessor,
): proc is BullQueueAdvancedProcessor {
  return (
    typeof proc === "object" &&
    proc !== null &&
    !(proc instanceof URL) &&
    "callback" in proc &&
    typeof proc.callback === "function"
  );
}

function createNativeWorkerHandle(
  queue: Queue<any, any>,
): BullMQWorkerLike<any, any> {
  return {
    name: queue.name,
    on(event: string, listener: (...args: any[]) => void) {
      queue.on(event, listener);
      return this;
    },
    off(event: string, listener: (...args: any[]) => void) {
      queue.off(event, listener);
      return this;
    },
    async pause() {
      queue.pause();
    },
    resume() {
      queue.resume();
    },
    async waitUntilReady() {
      return;
    },
    async close() {
      await queue.close();
    },
  };
}

function bridgeQueueToQueueEvents(
  queue: Queue<any, any>,
  queueEvents: QueueEvents,
): () => void {
  let seq = 0;
  const nextId = () => `${Date.now()}-${++seq}`;
  const unbinders: Array<() => void> = [];

  unbinders.push(
    queue.on("added", (job) => {
      queueEvents.emit("added", { jobId: job.id, name: job.name }, nextId());
    }),
  );
  unbinders.push(
    queue.on("delayed", (job, delay) => {
      queueEvents.emit(
        "delayed",
        {
          jobId: job.id,
          delay: typeof delay === "number" ? delay : job.processAfter,
        },
        nextId(),
      );
    }),
  );
  unbinders.push(
    queue.on("active", (job) => {
      queueEvents.emit("active", { jobId: job.id, prev: "waiting" }, nextId());
    }),
  );
  unbinders.push(
    queue.on("completed", (job, result) => {
      queueEvents.emit(
        "completed",
        {
          jobId: job.id,
          returnvalue: result ?? job.returnValue,
          prev: "active",
        },
        nextId(),
      );
    }),
  );
  unbinders.push(
    queue.on("failed", (job, err) => {
      const failedReason =
        err instanceof Error
          ? err.message
          : (job.failedReason ?? String(err ?? ""));
      queueEvents.emit(
        "failed",
        { jobId: job.id, failedReason, prev: "active" },
        nextId(),
      );
    }),
  );
  unbinders.push(
    queue.on("stalled", (job) => {
      queueEvents.emit("stalled", { jobId: job.id }, nextId());
    }),
  );
  unbinders.push(
    queue.on("dead-letter", (job, err) => {
      const failedReason =
        err instanceof Error
          ? err.message
          : (job.failedReason ?? String(err ?? ""));
      queueEvents.emit("dead-letter", { jobId: job.id, failedReason }, nextId());
    }),
  );
  unbinders.push(
    queue.on("paused", () => {
      queueEvents.emit("paused", {}, nextId());
    }),
  );
  unbinders.push(
    queue.on("resumed", () => {
      queueEvents.emit("resumed", {}, nextId());
    }),
  );
  unbinders.push(
    queue.on("drained", () => {
      queueEvents.emit("drained", nextId());
    }),
  );

  const cleanup = () => {
    for (const unbind of unbinders.splice(0)) {
      unbind();
    }
  };
  queueEvents._trackUnbinder(cleanup);
  return cleanup;
}

/**
 * Official BullMQ adapter implementing Bunest's `QueueDriver` contract around
 * user-injected BullMQ `Queue` and `Worker` factories without forcing `bullmq`
 * as a hard runtime dependency.
 */
export class BullMQQueueDriver implements QueueDriver {
  private readonly queues = new Map<string, BullMQQueueLike<any, any>>();
  private readonly workers = new Map<string, BullMQWorkerLike<any, any>>();
  private readonly queueFactories = new Map<string, BullMQQueueFactory>();
  private readonly workerFactories = new Map<string, BullMQWorkerFactory>();
  private closed = false;

  constructor(private readonly options: BullRootModuleOptions) {}

  registerQueueFactories(
    queueName: string,
    factories: {
      readonly createQueue?: BullMQQueueFactory;
      readonly createWorker?: BullMQWorkerFactory;
    },
  ): void {
    if (factories.createQueue) {
      this.queueFactories.set(queueName, factories.createQueue);
    }
    if (factories.createWorker) {
      this.workerFactories.set(queueName, factories.createWorker);
    }
  }

  getBullQueue<TData = unknown, TResult = unknown>(
    queueName: string,
  ): BullMQQueueLike<TData, TResult> {
    let q = this.queues.get(queueName);
    if (!q) {
      const factory =
        this.queueFactories.get(queueName) ?? this.options.createQueue;
      if (!factory) {
        throw new Error(
          `BullMQQueueDriver has no "createQueue" factory configured for queue "${queueName}".`,
        );
      }
      q = factory(queueName, {
        connection: this.options.connection,
        prefix: this.options.prefix,
        defaultJobOptions: this.options.defaultJobOptions,
      });
      this.queues.set(queueName, q);
    }
    return q as BullMQQueueLike<TData, TResult>;
  }

  getBullWorker<TData = unknown, TResult = unknown>(
    queueName: string,
  ): BullMQWorkerLike<TData, TResult> | undefined {
    return this.workers.get(queueName) as
      | BullMQWorkerLike<TData, TResult>
      | undefined;
  }

  hasWorkerFactory(queueName: string): boolean {
    return (
      this.workerFactories.has(queueName) ||
      typeof this.options.createWorker === "function"
    );
  }

  attachWorker<TData = unknown, TResult = unknown>(
    queueName: string,
    processor: BullMQProcessorFn<TData, TResult>,
    options: {
      readonly concurrency?: number;
      readonly workerOptions?: NestWorkerOptions;
    } = {},
  ): BullMQWorkerLike<TData, TResult> {
    const existing = this.workers.get(queueName);
    if (existing) {
      return existing as BullMQWorkerLike<TData, TResult>;
    }

    const factory =
      this.workerFactories.get(queueName) ?? this.options.createWorker;
    if (!factory) {
      throw new Error(
        `BullMQQueueDriver has no "createWorker" factory configured for queue "${queueName}".`,
      );
    }

    const worker = factory(queueName, processor as BullMQProcessorFn, {
      connection: this.options.connection,
      prefix: this.options.prefix,
      concurrency: options.concurrency,
      workerOptions: options.workerOptions,
    });
    this.workers.set(queueName, worker);
    return worker as BullMQWorkerLike<TData, TResult>;
  }

  async enqueue<TData = unknown, TResult = unknown>(
    queueName: string,
    job: Job<TData, TResult>,
  ): Promise<Job<TData, TResult>> {
    const bullQueue = this.getBullQueue<TData, TResult>(queueName);
    const effectiveJobId = job.idempotencyKey ?? job.id;

    if (effectiveJobId) {
      const existing = await bullQueue.getJob(effectiveJobId);
      if (existing) {
        return await normalizeBullJob(queueName, existing);
      }
    }

    const delay = Math.max(0, job.processAfter - Date.now());
    const bullOpts: Record<string, unknown> = {
      jobId: effectiveJobId,
      attempts: job.maxAttempts,
      removeOnComplete: job.removeOnComplete,
    };
    if (job.priority !== 0) {
      bullOpts.priority = job.priority;
    }
    if (delay > 0) {
      bullOpts.delay = delay;
    }
    if (job.backoff) {
      bullOpts.backoff = {
        type: job.backoff.type,
        delay: job.backoff.delayMs,
      };
    }

    const created = await bullQueue.add(job.name, job.data, bullOpts);
    return await normalizeBullJob(
      queueName,
      created,
      delay > 0 ? "delayed" : "waiting",
    );
  }

  async dequeue<TData = unknown, TResult = unknown>(): Promise<Job<
    TData,
    TResult
  > | null> {
    // BullMQ uses push-based `Worker` instances attached via `attachWorker()`.
    return null;
  }

  async ack<TData = unknown, TResult = unknown>(
    queueName: string,
    jobId: string,
  ): Promise<Job<TData, TResult> | null> {
    return await this.getJob<TData, TResult>(queueName, jobId);
  }

  async nack<TData = unknown, TResult = unknown>(
    queueName: string,
    jobId: string,
  ): Promise<Job<TData, TResult> | null> {
    return await this.getJob<TData, TResult>(queueName, jobId);
  }

  async moveToDeadLetter<TData = unknown, TResult = unknown>(
    queueName: string,
    jobId: string,
  ): Promise<Job<TData, TResult> | null> {
    return await this.getJob<TData, TResult>(queueName, jobId);
  }

  async getJob<TData = unknown, TResult = unknown>(
    queueName: string,
    jobId: string,
  ): Promise<Job<TData, TResult> | null> {
    const bullQueue = this.getBullQueue<TData, TResult>(queueName);
    const found = await bullQueue.getJob(jobId);
    if (!found) {
      return null;
    }
    return await normalizeBullJob(queueName, found);
  }

  async getCounts(queueName: string): Promise<QueueCounts> {
    const bullQueue = this.getBullQueue(queueName);
    if (typeof bullQueue.getJobCounts !== "function") {
      return {
        waiting: 0,
        delayed: 0,
        active: 0,
        completed: 0,
        failed: 0,
        deadLetter: 0,
      };
    }
    const counts = await bullQueue.getJobCounts(
      "waiting",
      "delayed",
      "active",
      "completed",
      "failed",
    );
    const failed = Number(counts.failed ?? 0);
    return {
      waiting: Number(counts.waiting ?? 0),
      delayed: Number(counts.delayed ?? 0),
      active: Number(counts.active ?? 0),
      completed: Number(counts.completed ?? 0),
      failed,
      deadLetter: failed,
    };
  }

  async getDeadLetterJobs<TData = unknown, TResult = unknown>(
    queueName: string,
  ): Promise<Job<TData, TResult>[]> {
    const bullQueue = this.getBullQueue<TData, TResult>(queueName);
    if (typeof bullQueue.getFailed !== "function") {
      return [];
    }
    const failedJobs = await bullQueue.getFailed(0, -1);
    return await Promise.all(
      failedJobs.map((j) => normalizeBullJob(queueName, j, "dead-letter")),
    );
  }

  async retryDeadLetterJob<TData = unknown, TResult = unknown>(
    queueName: string,
    jobId: string,
  ): Promise<Job<TData, TResult> | null> {
    const bullQueue = this.getBullQueue<TData, TResult>(queueName);
    const found = await bullQueue.getJob(jobId);
    if (!found) {
      return null;
    }
    if (typeof found.retry === "function") {
      await found.retry("failed");
    }
    return await normalizeBullJob(queueName, found, "waiting");
  }

  async closeWorkers(): Promise<void> {
    const activeWorkers = [...this.workers.values()];
    this.workers.clear();
    await Promise.all(activeWorkers.map((worker) => worker.close()));
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    await this.closeWorkers();

    const activeQueues = [...this.queues.values()];
    this.queues.clear();
    await Promise.all(activeQueues.map((queue) => queue.close()));
  }
}

/**
 * Discovers `@Processor()`, `WorkerHost`, `@Process()`, `@OnWorkerEvent()`,
 * `@QueueEventsListener()`, `QueueEventsHost`, and `@OnQueueEvent()` handlers across
 * all loaded modules, binds them to BullMQ `Worker`s (or Bun-native `Queue`s),
 * and gracefully drains workers and queues on `onModuleDestroy`.
 */
@Injectable()
export class BullMQExplorer
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private static _workerClass?: Type<any>;

  static set workerClass(cls: Type<any> | undefined) {
    this._workerClass = cls;
  }

  static get workerClass(): Type<any> | undefined {
    return this._workerClass;
  }

  private readonly detachHandlers: Array<() => void> = [];
  private readonly customWorkers: Array<{ close(): Promise<void> | void }> = [];
  private readonly queueEventsByQueue = new Map<string, QueueEvents[]>();
  private readonly allQueueEvents: QueueEvents[] = [];
  private registered = false;

  constructor(
    @Optional() private readonly moduleRef: ModuleRef | undefined,
    @Optional() private readonly discoveryService: DiscoveryService | undefined,
    @Inject(QUEUE_REGISTRY) private readonly registry: QueueRegistry,
    @Optional() @Inject(BULLMQ_DRIVER) private readonly driver?: BullMQQueueDriver,
    @Optional()
    private readonly processorDecoratorService?: ProcessorDecoratorService,
  ) {}

  onApplicationBootstrap(): void {
    const extraOptions = this.getModuleExtras();
    if (extraOptions?.manualRegistration) {
      return;
    }
    if (!this.registered) {
      this.register();
    }
  }

  register(): void {
    if (this.registered) {
      return;
    }
    this.registered = true;

    const wrappers = getAllLoadedWrappers(this.discoveryService);
    const decoratorService = this.resolveDecoratorService();
    const decorate = <TData = any, TResult = any>(
      fn: JobHandler<TData, TResult>,
    ): JobHandler<TData, TResult> =>
      decoratorService ? decoratorService.decorate(fn) : fn;

    // Register QueueEventsListeners first so worker/queue events can immediately forward into them
    for (const wrapper of wrappers) {
      const ctor = resolveWrapperMetatype(wrapper);
      if (!ctor) continue;

      const listenerMeta = MetadataRegistry.get<QueueEventsListenerOptions>(
        QUEUE_EVENTS_LISTENER_METADATA,
        ctor,
      );
      if (listenerMeta) {
        this.registerQueueEventsListener(wrapper, ctor, listenerMeta);
      }
    }

    for (const wrapper of wrappers) {
      const ctor = resolveWrapperMetatype(wrapper);
      if (!ctor) continue;

      const processorMeta = MetadataRegistry.get<ProcessorMetadata>(
        QUEUE_PROCESSOR_METADATA,
        ctor,
      );
      if (!processorMeta) continue;

      this.registerProcessor(wrapper, ctor, processorMeta, decorate);
    }
  }

  private resolveDecoratorService(): ProcessorDecoratorService | undefined {
    if (this.processorDecoratorService) {
      return this.processorDecoratorService;
    }
    try {
      return this.moduleRef?.get(ProcessorDecoratorService, { strict: false });
    } catch {
      return undefined;
    }
  }

  private getModuleExtras(): BullModuleExtraOptions | null {
    if (!this.moduleRef) {
      return null;
    }
    try {
      return this.moduleRef.get<BullModuleExtraOptions>(
        BULL_EXTRA_OPTIONS_TOKEN,
        { strict: false },
      );
    } catch {
      return null;
    }
  }

  private getQueueOptions(
    queueName: string,
    configKey?: string,
  ): RegisterQueueOptions {
    let shared: BullRootModuleOptions = {};
    let perQueue: RegisterQueueOptions = {};
    if (this.moduleRef) {
      try {
        shared =
          this.moduleRef.get<BullRootModuleOptions>(
            getSharedConfigToken(configKey),
            { strict: false },
          ) ?? {};
      } catch {
        // No shared config registered for configKey
      }
      try {
        perQueue =
          this.moduleRef.get<RegisterQueueOptions>(
            getQueueOptionsToken(queueName),
            { strict: false },
          ) ?? {};
      } catch {
        // No per-queue options registered
      }
    }
    return { ...shared, ...perQueue };
  }

  private emitToQueueEvents(
    queueName: string,
    event: string,
    args: unknown,
  ): void {
    const list = this.queueEventsByQueue.get(queueName);
    if (!list || list.length === 0) return;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    for (const qe of list) {
      qe.emit(event, args, id);
    }
  }

  private registerQueueEventsListener(
    wrapper: InstanceWrapper,
    ctor: Function,
    listenerMeta: QueueEventsListenerOptions,
  ): void {
    const instance = wrapper.instance;
    if (!instance || typeof instance !== "object") {
      return;
    }

    const queueEvents = new QueueEvents(listenerMeta.queueName);
    this.allQueueEvents.push(queueEvents);

    let list = this.queueEventsByQueue.get(listenerMeta.queueName);
    if (!list) {
      list = [];
      this.queueEventsByQueue.set(listenerMeta.queueName, list);
    }
    list.push(queueEvents);

    if (instance instanceof QueueEventsHost) {
      (instance as unknown as { _queueEvents?: QueueEvents })._queueEvents =
        queueEvents;
    }

    const queue = this.registry.get(listenerMeta.queueName);
    if (queue && !this.driver?.hasWorkerFactory(listenerMeta.queueName)) {
      const unbind = bridgeQueueToQueueEvents(queue, queueEvents);
      this.detachHandlers.push(unbind);
    }

    const eventMetas = collectMergedClassArray<QueueEventMetadata>(
      QUEUE_EVENT_METADATA,
      ctor,
    );
    for (const meta of eventMetas) {
      const fn = (instance as Record<string | symbol, unknown>)[meta.methodName];
      if (typeof fn === "function") {
        const listener = (...args: any[]) => (fn as Function).apply(instance, args);
        queueEvents.on(meta.eventName ?? meta.event, listener);
      }
    }
  }

  private registerProcessor(
    wrapper: InstanceWrapper,
    ctor: Function,
    processorMeta: ProcessorMetadata,
    decorate: <TData = any, TResult = any>(
      fn: JobHandler<TData, TResult>,
    ) => JobHandler<TData, TResult>,
  ): void {
    const queueName = processorMeta.queueName;
    const queue = this.registry.get(queueName);
    const queueOpts = this.getQueueOptions(queueName, processorMeta.configKey);
    const concurrency =
      processorMeta.workerOptions?.concurrency ??
      processorMeta.concurrency ??
      queueOpts.concurrency;

    const isRequestScoped =
      !wrapper.isDependencyTreeStatic ||
      wrapper.scope === Scope.REQUEST ||
      processorMeta.scope === Scope.REQUEST;

    const processMetas = collectMergedClassArray<ProcessMethodMetadata>(
      QUEUE_PROCESS_METADATA,
      ctor,
    );

    const namedHandlers = new Map<string, JobHandler<any, any>>();
    let defaultHandler: JobHandler<any, any> | undefined;

    if (isRequestScoped) {
      if (processMetas.length > 0) {
        for (const meta of processMetas) {
          const bound = decorate(async (job: Job<any, any>, token?: string) => {
            const contextId = ContextIdFactory.create();
            wrapper.moduleRef.registerRequestByContextId(job, contextId);
            const scopedInstance = (await wrapper.moduleRef.resolve(
              wrapper.token,
              contextId,
              { strict: false },
            )) as Record<string | symbol, unknown>;
            const fn = scopedInstance[meta.methodName];
            if (typeof fn !== "function") {
              throw new Error(
                `Method "${String(meta.methodName)}" not found on request-scoped processor "${ctor.name}".`,
              );
            }
            return await (fn as Function).call(scopedInstance, job, token);
          });
          if (meta.jobName !== undefined && meta.jobName !== "*") {
            namedHandlers.set(meta.jobName, bound);
          } else {
            defaultHandler = bound;
          }
        }
      } else {
        defaultHandler = decorate(async (job: Job<any, any>, token?: string) => {
          const contextId = ContextIdFactory.create();
          wrapper.moduleRef.registerRequestByContextId(job, contextId);
          const scopedInstance = (await wrapper.moduleRef.resolve(
            wrapper.token,
            contextId,
            { strict: false },
          )) as WorkerHost;
          return await scopedInstance.process(job, token);
        });
      }
    } else {
      const instance = wrapper.instance;
      if (!instance || typeof instance !== "object") {
        return;
      }

      if (processMetas.length > 0) {
        for (const meta of processMetas) {
          const fn = (instance as Record<string | symbol, unknown>)[
            meta.methodName
          ];
          if (typeof fn !== "function") continue;
          const bound = decorate((job: Job<any, any>, token?: string) =>
            (fn as Function).call(instance, job, token),
          );
          if (meta.jobName !== undefined && meta.jobName !== "*") {
            namedHandlers.set(meta.jobName, bound);
          } else {
            defaultHandler = bound;
          }
        }
      } else if (
        instance instanceof WorkerHost ||
        typeof (instance as { process?: unknown }).process === "function"
      ) {
        defaultHandler = decorate((job: Job<any, any>, token?: string) =>
          (instance as WorkerHost).process(job, token),
        );
      }
    }

    const instance = !isRequestScoped ? wrapper.instance : undefined;
    const eventHandlers = new Map<
      string,
      Array<(...args: any[]) => Promise<void> | void>
    >();

    if (instance && typeof instance === "object") {
      // Legacy @OnQueueEvent on @Processor
      for (const meta of collectMergedClassArray<QueueEventMetadata>(
        QUEUE_EVENT_METADATA,
        ctor,
      )) {
        const fn = (instance as Record<string | symbol, unknown>)[
          meta.methodName
        ];
        if (typeof fn !== "function") continue;
        const eventName = meta.eventName ?? meta.event;
        const listener = (...args: any[]) =>
          (fn as Function).apply(instance, args);
        let list = eventHandlers.get(eventName);
        if (!list) {
          list = [];
          eventHandlers.set(eventName, list);
        }
        list.push(listener);
      }

      // BullMQ v5/v6 @OnWorkerEvent on @Processor
      for (const meta of collectMergedClassArray<WorkerEventMetadata>(
        QUEUE_WORKER_EVENT_METADATA,
        ctor,
      )) {
        const fn = (instance as Record<string | symbol, unknown>)[
          meta.methodName
        ];
        if (typeof fn !== "function") continue;
        const listener = (...args: any[]) =>
          (fn as Function).apply(instance, args);
        let list = eventHandlers.get(meta.eventName);
        if (!list) {
          list = [];
          eventHandlers.set(meta.eventName, list);
        }
        list.push(listener);
      }
    }

    // 1. Custom BullModule.workerClass override
    if (BullMQExplorer._workerClass) {
      const WorkerCtor = BullMQExplorer._workerClass;
      const mergedWorkerOpts: NestWorkerOptions = {
        connection: queueOpts.connection,
        prefix: queueOpts.prefix,
        concurrency,
        ...processorMeta.workerOptions,
      };
      const worker = new WorkerCtor(
        queueName,
        async (rawJob: BullMQJobLike, token?: string) => {
          const normalized = normalizeBullJobSync(queueName, rawJob, "active");
          const handler = namedHandlers.get(normalized.name) ?? defaultHandler;
          if (!handler) {
            throw new Error(
              `No processor handler registered for job "${normalized.name}" on queue "${queueName}".`,
            );
          }
          return await handler(normalized, token);
        },
        mergedWorkerOpts,
      ) as BullMQWorkerLike;
      this.customWorkers.push(worker);

      if (instance instanceof WorkerHost) {
        (instance as unknown as { _worker?: BullMQWorkerLike })._worker = worker;
      }

      if (typeof worker.on === "function") {
        for (const [eventName, listeners] of eventHandlers.entries()) {
          for (const listener of listeners) {
            worker.on(eventName, listener);
            this.detachHandlers.push(() => worker.off?.(eventName, listener));
          }
        }
      }
      return;
    }

    // 2. BullMQQueueDriver worker factory mode
    if (this.driver?.hasWorkerFactory(queueName)) {
      const worker = this.driver.attachWorker(
        queueName,
        async (bullJob, token) => {
          const normalized = normalizeBullJobSync(queueName, bullJob, "active");
          const handler = namedHandlers.get(normalized.name) ?? defaultHandler;
          if (!handler) {
            throw new Error(
              `No @Process() or WorkerHost.process() handler registered for job "${normalized.name}" on BullMQ queue "${queueName}".`,
            );
          }
          return await handler(normalized, token);
        },
        {
          concurrency,
          workerOptions: processorMeta.workerOptions,
        },
      );

      if (instance instanceof WorkerHost) {
        (instance as unknown as { _worker?: BullMQWorkerLike })._worker = worker;
      }

      const dispatchEvent = (
        event: QueueEventName | string,
        rawJob: BullMQJobLike | string | undefined,
        payload?: unknown,
      ) => {
        const listeners = eventHandlers.get(event);
        if (listeners && listeners.length > 0) {
          const job: Job<any, any> =
            rawJob && typeof rawJob === "object"
              ? normalizeBullJobSync(queueName, rawJob)
              : {
                  id: typeof rawJob === "string" ? rawJob : "",
                  queueName,
                  name: "",
                  data: undefined,
                  priority: 0,
                  maxAttempts: 1,
                  attemptsMade: 0,
                  status: event === "completed" ? "completed" : "active",
                  removeOnComplete: false,
                  createdAt: Date.now(),
                  processAfter: Date.now(),
                  stacktrace: [],
                };

          for (const listener of listeners) {
            try {
              void listener(job, payload);
            } catch {
              // Never crash BullMQ worker event emitter
            }
          }
        }

        // Also forward to any @QueueEventsListener for this queue
        const jobId =
          rawJob && typeof rawJob === "object"
            ? String(rawJob.id ?? rawJob.opts?.jobId ?? "")
            : typeof rawJob === "string"
              ? rawJob
              : "";
        if (event === "completed") {
          this.emitToQueueEvents(queueName, "completed", {
            jobId,
            returnvalue: payload,
            prev: "active",
          });
        } else if (event === "failed") {
          const failedReason =
            payload instanceof Error ? payload.message : String(payload ?? "");
          this.emitToQueueEvents(queueName, "failed", {
            jobId,
            failedReason,
            prev: "active",
          });
        } else if (event === "active") {
          this.emitToQueueEvents(queueName, "active", {
            jobId,
            prev: "waiting",
          });
        } else if (event === "stalled") {
          this.emitToQueueEvents(queueName, "stalled", { jobId });
        }
      };

      if (typeof worker.on === "function") {
        const onActive = (job: BullMQJobLike) => dispatchEvent("active", job);
        const onCompleted = (job: BullMQJobLike, result: unknown) =>
          dispatchEvent("completed", job, result);
        const onFailed = (job: BullMQJobLike | undefined, err: Error) => {
          dispatchEvent("failed", job, err);
          const maxAttempts = job?.opts?.attempts ?? 1;
          const attemptsMade = job?.attemptsMade ?? 1;
          if (attemptsMade >= maxAttempts) {
            dispatchEvent("dead-letter", job, err);
          }
        };
        const onStalled = (jobId: string) => dispatchEvent("stalled", jobId);

        worker.on("active", onActive);
        worker.on("completed", onCompleted);
        worker.on("failed", onFailed);
        worker.on("stalled", onStalled);

        this.detachHandlers.push(() => {
          worker.off?.("active", onActive);
          worker.off?.("completed", onCompleted);
          worker.off?.("failed", onFailed);
          worker.off?.("stalled", onStalled);
        });

        // Bind any extra custom @OnWorkerEvent listeners (e.g. "drained", "progress", "error", "paused")
        for (const [eventName, listeners] of eventHandlers.entries()) {
          if (
            eventName === "active" ||
            eventName === "completed" ||
            eventName === "failed" ||
            eventName === "stalled" ||
            eventName === "dead-letter"
          ) {
            continue;
          }
          for (const listener of listeners) {
            worker.on(eventName, listener);
            this.detachHandlers.push(() => worker.off?.(eventName, listener));
          }
        }
      }
      return;
    }

    // 3. Bun-native zero-dependency Queue mode
    if (!queue) {
      return;
    }

    if (instance instanceof WorkerHost) {
      (instance as unknown as { _worker?: BullMQWorkerLike })._worker =
        createNativeWorkerHandle(queue);
    }

    for (const [event, listeners] of eventHandlers.entries()) {
      for (const listener of listeners) {
        this.detachHandlers.push(queue.on(event, listener));
      }
    }
    if (concurrency !== undefined) {
      queue.setConcurrency(concurrency);
    }
    for (const [jobName, handler] of namedHandlers.entries()) {
      queue.process(jobName, handler);
    }
    if (defaultHandler) {
      queue.process(defaultHandler);
    }
  }

  async onModuleDestroy(): Promise<void> {
    // Gracefully drain active BullMQ workers before detaching listeners so
    // in-flight completion/failure events are still observed.
    if (this.driver) {
      await this.driver.closeWorkers();
    }
    await Promise.all(this.customWorkers.splice(0).map((w) => w.close()));
    await this.registry.closeAll();

    for (const qe of this.allQueueEvents.splice(0)) {
      await qe.close();
    }
    this.queueEventsByQueue.clear();

    for (const detach of this.detachHandlers.splice(0)) {
      detach();
    }

    if (this.driver) {
      await this.driver.close();
    }
    this.registered = false;
  }
}

/**
 * Manual registration controller for `BullModule`.
 * When `extraOptions: { manualRegistration: true }` is configured, `onModuleInit()`
 * defers worker/listener binding until the application explicitly invokes `register()`.
 */
@Injectable()
export class BullRegistrar implements OnModuleInit {
  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly bullExplorer: BullMQExplorer,
  ) {}

  onModuleInit(): void {
    const extraOptions = this.getModuleExtras();
    if (extraOptions?.manualRegistration) {
      return;
    }
    this.register();
  }

  register(): void {
    this.bullExplorer.register();
  }

  private getModuleExtras(): BullModuleExtraOptions | null {
    try {
      return this.moduleRef.get<BullModuleExtraOptions>(
        BULL_EXTRA_OPTIONS_TOKEN,
        { strict: false },
      );
    } catch {
      return null;
    }
  }
}

/**
 * Singleton core module shared across all `BullModule` / `BullMQModule` dynamic imports.
 */
@Global()
@Module({
  providers: [
    QueueRegistry,
    {
      provide: QUEUE_REGISTRY,
      useExisting: QueueRegistry,
    },
    {
      provide: JOB_REF,
      scope: Scope.REQUEST,
      useFactory: (job: unknown) => job,
      inject: [{ token: REQUEST, optional: true }],
    },
    ProcessorDecoratorService,
    BullMQExplorer,
    BullRegistrar,
  ],
  exports: [
    QueueRegistry,
    QUEUE_REGISTRY,
    JOB_REF,
    ProcessorDecoratorService,
    BullMQExplorer,
    BullRegistrar,
  ],
})
class BullCoreModule {}

function attachInlineProcessors(
  queue: Queue<any, any>,
  processors: readonly BullQueueProcessor[] | undefined,
): void {
  if (!processors || processors.length === 0) {
    return;
  }
  for (const proc of processors) {
    if (typeof proc === "function") {
      queue.process(proc);
    } else if (isAdvancedProcessor(proc)) {
      if (proc.concurrency !== undefined) {
        queue.setConcurrency(proc.concurrency);
      }
      if (proc.name) {
        queue.process(proc.name, proc.callback);
      } else {
        queue.process(proc.callback);
      }
    }
  }
}

function buildQueueInstance(
  name: string,
  queueConfig: RegisterQueueOptions,
  sharedConfig: BullRootModuleOptions | undefined,
  bullDriver: BullMQQueueDriver | undefined,
  rootDriver: QueueDriver | undefined,
  registry: QueueRegistry | undefined,
  customQueueClass: Type<any> | undefined,
): any {
  const merged: RegisterQueueOptions = {
    ...sharedConfig,
    ...queueConfig,
    defaultJobOptions: {
      ...sharedConfig?.defaultJobOptions,
      ...queueConfig.defaultJobOptions,
    },
  };

  if (customQueueClass) {
    const instance = new customQueueClass(name, merged);
    return instance;
  }

  const effectiveCreateQueue =
    queueConfig.createQueue ?? sharedConfig?.createQueue;
  const effectiveCreateWorker =
    queueConfig.createWorker ?? sharedConfig?.createWorker;

  let activeDriver: QueueDriver;
  if (bullDriver && effectiveCreateQueue) {
    bullDriver.registerQueueFactories(name, {
      createQueue: queueConfig.createQueue,
      createWorker: effectiveCreateWorker,
    });
    bullDriver.getBullQueue(name);
    activeDriver = bullDriver;
  } else if (effectiveCreateQueue) {
    const localDriver = new BullMQQueueDriver({
      ...merged,
      createQueue: effectiveCreateQueue,
      createWorker: effectiveCreateWorker,
    });
    localDriver.getBullQueue(name);
    activeDriver = localDriver;
  } else {
    activeDriver = merged.driver ?? rootDriver ?? new MemoryQueueDriver();
  }

  const queue = new Queue({
    name,
    driver: activeDriver,
    concurrency: merged.concurrency,
    defaultJobOptions: merged.defaultJobOptions,
    shutdownTimeoutMs:
      queueConfig.shutdownTimeoutMs ?? sharedConfig?.shutdownTimeoutMs,
    pollIntervalMs: merged.pollIntervalMs,
  });

  attachInlineProcessors(queue, queueConfig.processors);
  registry?.register(queue);
  return queue;
}

/**
 * NestJS `@nestjs/bullmq` v12 compatible queue module for Bunest.
 *
 * Supports `forRoot` / `forRootAsync` (with optional named `configKey`),
 * `registerQueue` / `registerQueueAsync`, `registerFlowProducer` / `registerFlowProducerAsync`,
 * custom `queueClass` / `workerClass` / `flowProducerClass`, `WorkerHost`,
 * `QueueEventsHost`, `BullRegistrar`, and `ProcessorDecoratorService` — with zero
 * external runtime dependencies.
 */
@Module({})
export class BullModule {
  private static _queueClass?: Type<any>;
  private static _flowProducerClass?: Type<any>;
  private static _workerClass?: Type<any>;

  static set queueClass(cls: Type<any> | undefined) {
    BullModule._queueClass = cls;
  }

  static get queueClass(): Type<any> | undefined {
    return BullModule._queueClass;
  }

  static set flowProducerClass(cls: Type<any> | undefined) {
    BullModule._flowProducerClass = cls;
  }

  static get flowProducerClass(): Type<any> | undefined {
    return BullModule._flowProducerClass;
  }

  static set workerClass(cls: Type<any> | undefined) {
    BullModule._workerClass = cls;
    BullMQExplorer.workerClass = cls;
  }

  static get workerClass(): Type<any> | undefined {
    return BullModule._workerClass;
  }

  static forRoot(bullConfig?: BullRootModuleOptions): DynamicModule;
  static forRoot(
    configKey: string,
    bullConfig: BullRootModuleOptions,
  ): DynamicModule;
  static forRoot(
    keyOrConfig?: string | BullRootModuleOptions,
    maybeBullConfig?: BullRootModuleOptions,
  ): DynamicModule {
    const [configKey, sharedBullConfig] =
      typeof keyOrConfig === "string"
        ? [keyOrConfig, maybeBullConfig ?? {}]
        : [undefined, keyOrConfig ?? {}];

    const { extraOptions, ...config } = sharedBullConfig;
    const sharedConfigToken = getSharedConfigToken(configKey);

    const providers: Provider[] = [
      {
        provide: sharedConfigToken,
        useValue: config,
      },
    ];
    const exportsList: ModuleExport[] = [sharedConfigToken];

    // Only register default global tokens when no custom configKey is specified
    // so multiple `BullModule.forRoot("keyA", ...)` + `BullModule.forRoot("keyB", ...)`
    // registrations never collide on default tokens.
    if (configKey === undefined) {
      providers.push({
        provide: BULL_EXTRA_OPTIONS_TOKEN,
        useValue: { ...extraOptions },
      });
      exportsList.push(BULL_EXTRA_OPTIONS_TOKEN);

      providers.push({
        provide: BULLMQ_MODULE_OPTIONS,
        useValue: sharedBullConfig,
      });
      exportsList.push(BULLMQ_MODULE_OPTIONS);

      if (sharedBullConfig.createQueue) {
        const bullDriver = new BullMQQueueDriver(sharedBullConfig);
        providers.push(
          {
            provide: BULLMQ_DRIVER,
            useValue: bullDriver,
          },
          {
            provide: BullMQQueueDriver,
            useExisting: BULLMQ_DRIVER,
          },
          {
            provide: QUEUE_DRIVER,
            useExisting: BULLMQ_DRIVER,
          },
          {
            provide: QUEUE_MODULE_OPTIONS,
            useValue: {
              driver: bullDriver,
              defaultJobOptions: sharedBullConfig.defaultJobOptions,
              shutdownTimeoutMs: sharedBullConfig.shutdownTimeoutMs,
              global: sharedBullConfig.global ?? true,
            },
          },
        );
        exportsList.push(
          BULLMQ_DRIVER,
          BullMQQueueDriver,
          QUEUE_DRIVER,
          QUEUE_MODULE_OPTIONS,
        );
      } else {
        const driver = sharedBullConfig.driver ?? new MemoryQueueDriver();
        providers.push(
          {
            provide: QUEUE_DRIVER,
            useValue: driver,
          },
          {
            provide: QUEUE_MODULE_OPTIONS,
            useValue: {
              driver,
              defaultJobOptions: sharedBullConfig.defaultJobOptions,
              shutdownTimeoutMs: sharedBullConfig.shutdownTimeoutMs,
              global: sharedBullConfig.global ?? true,
            },
          },
        );
        exportsList.push(QUEUE_DRIVER, QUEUE_MODULE_OPTIONS);
      }
    }

    return {
      global: sharedBullConfig.global ?? true,
      module: this,
      imports: [BullCoreModule],
      providers,
      exports: exportsList,
    };
  }

  static forRootAsync(
    asyncBullConfig: SharedBullAsyncConfiguration,
  ): DynamicModule;
  static forRootAsync(
    configKey: string,
    asyncBullConfig: SharedBullAsyncConfiguration,
  ): DynamicModule;
  static forRootAsync(
    keyOrAsyncConfig: string | SharedBullAsyncConfiguration,
    maybeAsyncBullConfig?: SharedBullAsyncConfiguration,
  ): DynamicModule {
    const [configKey, asyncConfig] =
      typeof keyOrAsyncConfig === "string"
        ? [keyOrAsyncConfig, maybeAsyncBullConfig!]
        : [undefined, keyOrAsyncConfig];

    const sharedConfigToken = getSharedConfigToken(configKey);
    const providers: Provider[] = [];
    const exportsList: ModuleExport[] = [sharedConfigToken];

    if (asyncConfig.useFactory) {
      providers.push({
        provide: sharedConfigToken,
        useFactory: asyncConfig.useFactory,
        inject: asyncConfig.inject ?? [],
      });
    } else if (asyncConfig.useClass) {
      providers.push(
        {
          provide: asyncConfig.useClass,
          useClass: asyncConfig.useClass,
        },
        {
          provide: sharedConfigToken,
          useFactory: async (factory: SharedBullConfigurationFactory) =>
            await factory.createSharedConfiguration(),
          inject: [asyncConfig.useClass],
        },
      );
    } else if (asyncConfig.useExisting) {
      providers.push({
        provide: sharedConfigToken,
        useFactory: async (factory: SharedBullConfigurationFactory) =>
          await factory.createSharedConfiguration(),
        inject: [asyncConfig.useExisting],
      });
    } else {
      throw new Error(
        "BullModule.forRootAsync() requires useFactory, useClass, or useExisting.",
      );
    }

    if (configKey === undefined) {
      providers.push(
        {
          provide: BULL_EXTRA_OPTIONS_TOKEN,
          useFactory: (resolved: BullRootModuleOptions) => ({
            ...resolved?.extraOptions,
            ...asyncConfig.extraOptions,
          }),
          inject: [sharedConfigToken],
        },
        {
          provide: BULLMQ_MODULE_OPTIONS,
          useExisting: sharedConfigToken,
        },
        {
          provide: BULLMQ_DRIVER,
          useFactory: (resolved: BullRootModuleOptions) =>
            resolved?.createQueue ? new BullMQQueueDriver(resolved) : undefined,
          inject: [sharedConfigToken],
        },
        {
          provide: QUEUE_DRIVER,
          useFactory: (
            resolved: BullRootModuleOptions,
            bullDriver?: BullMQQueueDriver,
          ) => bullDriver ?? resolved?.driver ?? new MemoryQueueDriver(),
          inject: [
            sharedConfigToken,
            { token: BULLMQ_DRIVER, optional: true },
          ],
        },
        {
          provide: QUEUE_MODULE_OPTIONS,
          useFactory: (
            resolved: BullRootModuleOptions,
            driver: QueueDriver,
          ) => ({
            driver,
            defaultJobOptions: resolved?.defaultJobOptions,
            shutdownTimeoutMs: resolved?.shutdownTimeoutMs,
            global: resolved?.global ?? true,
          }),
          inject: [sharedConfigToken, QUEUE_DRIVER],
        },
      );
      exportsList.push(
        BULL_EXTRA_OPTIONS_TOKEN,
        BULLMQ_MODULE_OPTIONS,
        BULLMQ_DRIVER,
        QUEUE_DRIVER,
        QUEUE_MODULE_OPTIONS,
      );
    }

    if (asyncConfig.extraProviders) {
      providers.push(...asyncConfig.extraProviders);
    }

    return {
      global: true,
      module: this,
      imports: [BullCoreModule, ...(asyncConfig.imports ?? [])],
      providers,
      exports: exportsList,
    };
  }

  static registerQueue(...options: RegisterQueueOptions[]): DynamicModule {
    const providers: Provider[] = [];
    const exportsList: ModuleExport[] = [];

    for (const config of options) {
      const name = config.name ?? "default";
      const optionsToken = getQueueOptionsToken(name);
      const queueToken = getQueueToken(name);
      const sharedToken = getSharedConfigToken(config.configKey);

      providers.push({
        provide: optionsToken,
        useValue: config,
      });

      providers.push({
        provide: queueToken,
        useFactory: (
          sharedConfig?: BullRootModuleOptions,
          bullDriver?: BullMQQueueDriver,
          rootDriver?: QueueDriver,
          registry?: QueueRegistry,
        ) =>
          buildQueueInstance(
            name,
            config,
            sharedConfig,
            bullDriver,
            rootDriver,
            registry,
            BullModule._queueClass,
          ),
        inject: [
          { token: sharedToken, optional: true },
          { token: BULLMQ_DRIVER, optional: true },
          { token: QUEUE_DRIVER, optional: true },
          { token: QUEUE_REGISTRY, optional: true },
        ],
      });

      exportsList.push(queueToken);
    }

    return {
      module: this,
      imports: [BullCoreModule],
      providers,
      exports: exportsList,
    };
  }

  static registerQueueAsync(
    ...options: RegisterQueueAsyncOptions[]
  ): DynamicModule {
    const providers: Provider[] = [];
    const exportsList: ModuleExport[] = [];
    const importsSet = new Set<any>([BullCoreModule]);

    for (const config of options) {
      const name = config.name ?? "default";
      const optionsToken = getQueueOptionsToken(name);
      const queueToken = getQueueToken(name);
      const sharedToken = getSharedConfigToken(config.configKey);

      for (const imp of config.imports ?? []) {
        importsSet.add(imp);
      }
      if (config.extraProviders) {
        providers.push(...config.extraProviders);
      }

      if (config.useFactory) {
        providers.push({
          provide: optionsToken,
          useFactory: config.useFactory,
          inject: config.inject ?? [],
        });
      } else if (config.useClass) {
        providers.push(
          {
            provide: config.useClass,
            useClass: config.useClass,
          },
          {
            provide: optionsToken,
            useFactory: async (factory: RegisterQueueOptionsFactory) =>
              await factory.createRegisterQueueOptions(),
            inject: [config.useClass],
          },
        );
      } else if (config.useExisting) {
        providers.push({
          provide: optionsToken,
          useFactory: async (factory: RegisterQueueOptionsFactory) =>
            await factory.createRegisterQueueOptions(),
          inject: [config.useExisting],
        });
      } else {
        throw new Error(
          `BullModule.registerQueueAsync("${name}") requires useFactory, useClass, or useExisting.`,
        );
      }

      providers.push({
        provide: queueToken,
        useFactory: (
          resolvedOpts: RegisterQueueOptions,
          sharedConfig?: BullRootModuleOptions,
          bullDriver?: BullMQQueueDriver,
          rootDriver?: QueueDriver,
          registry?: QueueRegistry,
        ) =>
          buildQueueInstance(
            resolvedOpts?.name ?? name,
            resolvedOpts ?? {},
            sharedConfig,
            bullDriver,
            rootDriver,
            registry,
            BullModule._queueClass,
          ),
        inject: [
          optionsToken,
          { token: sharedToken, optional: true },
          { token: BULLMQ_DRIVER, optional: true },
          { token: QUEUE_DRIVER, optional: true },
          { token: QUEUE_REGISTRY, optional: true },
        ],
      });

      exportsList.push(queueToken);
    }

    return {
      module: this,
      imports: [...importsSet],
      providers,
      exports: exportsList,
    };
  }

  static registerFlowProducer(
    ...options: RegisterFlowProducerOptions[]
  ): DynamicModule {
    const providers: Provider[] = [];
    const exportsList: ModuleExport[] = [];

    for (const config of options) {
      const name = config.name ?? "default";
      const optionsToken = getFlowProducerOptionsToken(name);
      const token = getFlowProducerToken(name);
      const sharedToken = getSharedConfigToken(config.configKey);

      providers.push({
        provide: optionsToken,
        useValue: config,
      });

      providers.push({
        provide: token,
        useFactory: (
          sharedConfig?: BullRootModuleOptions,
          rootDriver?: QueueDriver,
          registry?: QueueRegistry,
        ) => {
          const merged: RegisterFlowProducerOptions = {
            ...sharedConfig,
            ...config,
          };
          const producer = BullModule._flowProducerClass
            ? new BullModule._flowProducerClass(merged)
            : new FlowProducer(merged, registry, rootDriver);
          if (producer && typeof producer.close === "function") {
            registry?.registerFlowProducer(name, producer);
          }
          return producer;
        },
        inject: [
          { token: sharedToken, optional: true },
          { token: QUEUE_DRIVER, optional: true },
          { token: QUEUE_REGISTRY, optional: true },
        ],
      });

      exportsList.push(token);
    }

    return {
      module: this,
      imports: [BullCoreModule],
      providers,
      exports: exportsList,
    };
  }

  static registerFlowProducerAsync(
    ...options: RegisterFlowProducerAsyncOptions[]
  ): DynamicModule {
    const providers: Provider[] = [];
    const exportsList: ModuleExport[] = [];
    const importsSet = new Set<any>([BullCoreModule]);

    for (const config of options) {
      const name = config.name ?? "default";
      const optionsToken = getFlowProducerOptionsToken(name);
      const token = getFlowProducerToken(name);
      const sharedToken = getSharedConfigToken(config.configKey);

      for (const imp of config.imports ?? []) {
        importsSet.add(imp);
      }

      if (config.useFactory) {
        providers.push({
          provide: optionsToken,
          useFactory: config.useFactory,
          inject: config.inject ?? [],
        });
      } else if (config.useClass) {
        providers.push(
          {
            provide: config.useClass,
            useClass: config.useClass,
          },
          {
            provide: optionsToken,
            useFactory: async (factory: RegisterFlowProducerOptionsFactory) =>
              await factory.createRegisterQueueOptions(),
            inject: [config.useClass],
          },
        );
      } else if (config.useExisting) {
        providers.push({
          provide: optionsToken,
          useFactory: async (factory: RegisterFlowProducerOptionsFactory) =>
            await factory.createRegisterQueueOptions(),
          inject: [config.useExisting],
        });
      } else {
        throw new Error(
          `BullModule.registerFlowProducerAsync("${name}") requires useFactory, useClass, or useExisting.`,
        );
      }

      providers.push({
        provide: token,
        useFactory: (
          resolvedOpts: RegisterFlowProducerOptions,
          sharedConfig?: BullRootModuleOptions,
          rootDriver?: QueueDriver,
          registry?: QueueRegistry,
        ) => {
          const merged: RegisterFlowProducerOptions = {
            ...sharedConfig,
            ...resolvedOpts,
          };
          const producer = BullModule._flowProducerClass
            ? new BullModule._flowProducerClass(merged)
            : new FlowProducer(merged, registry, rootDriver);
          if (producer && typeof producer.close === "function") {
            registry?.registerFlowProducer(resolvedOpts?.name ?? name, producer);
          }
          return producer;
        },
        inject: [
          optionsToken,
          { token: sharedToken, optional: true },
          { token: QUEUE_DRIVER, optional: true },
          { token: QUEUE_REGISTRY, optional: true },
        ],
      });

      exportsList.push(token);
    }

    return {
      module: this,
      imports: [...importsSet],
      providers,
      exports: exportsList,
    };
  }
}

/**
 * Official BullMQ integration module for Bunest (alias/subclass of `BullModule`
 * maintaining full backwards compatibility with `BullMQModule.forRoot({ createQueue, ... })`).
 */
@Module({})
export class BullMQModule extends BullModule {}
