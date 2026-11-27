import {
  ClsService,
  ContextIdFactory,
  DiscoveryService,
  Inject,
  Injectable,
  MetadataRegistry,
  Module,
  Optional,
  REQUEST,
  Scope,
  type DynamicModule,
  type InstanceWrapper,
  type ModuleExport,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type Provider,
} from "@bunest/core";
import { MemoryQueueDriver } from "./drivers/memory.driver";
import { QueueEvents, QueueEventsHost } from "./hosts/queue-events-host.class";
import { WorkerHost } from "./hosts/worker-host.class";
import { ProcessorDecoratorService } from "./instrument/processor-decorator.service";
import type {
  BullMQWorkerLike,
  Job,
  JobHandler,
  ProcessMethodMetadata,
  ProcessorMetadata,
  QueueConfig,
  QueueDriver,
  QueueEventMetadata,
  QueueEventsListenerOptions,
  QueueModuleAsyncOptions,
  QueueModuleOptions,
  QueueModuleOptionsFactory,
  RegisterQueueConfigAsyncOptions,
  WorkerEventMetadata,
} from "./interfaces";
import { Queue } from "./queue";
import {
  JOB_REF,
  QUEUE_DRIVER,
  QUEUE_EVENTS_LISTENER_METADATA,
  QUEUE_EVENT_METADATA,
  QUEUE_MODULE_OPTIONS,
  QUEUE_PROCESSOR_METADATA,
  QUEUE_PROCESS_METADATA,
  QUEUE_REGISTRY,
  QUEUE_WORKER_EVENT_METADATA,
  getQueueOptionsToken,
  getQueueToken,
} from "./tokens";

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

function resolveWrapperMetatype(
  wrapper: InstanceWrapper,
): Function | undefined {
  if (wrapper.instance && typeof wrapper.instance === "object") {
    const ctor = (wrapper.instance as { constructor?: Function }).constructor;
    if (typeof ctor === "function") {
      return ctor;
    }
  }
  return typeof wrapper.metatype === "function" ? wrapper.metatype : undefined;
}

function createQueueWorkerHandle(
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

function bindQueueToQueueEvents(
  queue: Queue<any, any>,
  queueEvents: QueueEvents,
): () => void {
  let eventSeq = 0;
  const nextId = () => `${Date.now()}-${++eventSeq}`;
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
      queueEvents.emit(
        "dead-letter",
        { jobId: job.id, failedReason },
        nextId(),
      );
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
 * Central registry tracking active `Queue` and `FlowProducer` instances for
 * processor discovery and graceful shutdown.
 */
@Injectable()
export class QueueRegistry {
  private readonly queues = new Map<string, Queue<any, any>>();
  private readonly flowProducers = new Map<
    string,
    { close(): Promise<void> | void }
  >();

  register(queue: Queue<any, any>): void {
    this.queues.set(queue.name, queue);
  }

  get<TData = unknown, TResult = unknown>(
    name: string,
  ): Queue<TData, TResult> | undefined {
    return this.queues.get(name) as Queue<TData, TResult> | undefined;
  }

  getAll(): Queue<any, any>[] {
    return [...this.queues.values()];
  }

  registerFlowProducer(
    name: string,
    producer: { close(): Promise<void> | void },
  ): void {
    this.flowProducers.set(name, producer);
  }

  getFlowProducer<T = any>(name: string): T | undefined {
    return this.flowProducers.get(name) as T | undefined;
  }

  async closeAllWorkers(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.closeWorkers()));
  }

  async closeAll(): Promise<void> {
    await Promise.all([
      ...[...this.queues.values()].map((q) => q.close()),
      ...[...this.flowProducers.values()].map((fp) => fp.close()),
    ]);
    this.queues.clear();
    this.flowProducers.clear();
  }
}

/**
 * Discovers `@Processor()`, `WorkerHost`, `@Process()`, `@OnWorkerEvent()`,
 * `@QueueEventsListener()`, `QueueEventsHost`, and `@OnQueueEvent()` handlers across
 * all loaded modules on `onApplicationBootstrap` and drains queues on `onModuleDestroy`.
 */
@Injectable()
export class QueueExplorer implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly attachedUnbinders: Array<() => void> = [];
  private readonly queueEventsInstances: QueueEvents[] = [];

  constructor(
    @Optional() private readonly discoveryService: DiscoveryService | undefined,
    @Inject(QUEUE_REGISTRY) private readonly registry: QueueRegistry,
    @Optional() @Inject(QUEUE_DRIVER) private readonly driver?: QueueDriver,
    @Optional()
    private readonly processorDecoratorService?: ProcessorDecoratorService,
  ) {}

  onApplicationBootstrap(): void {
    const wrappers = getAllLoadedWrappers(this.discoveryService);
    const decorate = <TData = any, TResult = any>(
      fn: JobHandler<TData, TResult>,
    ): JobHandler<TData, TResult> =>
      this.processorDecoratorService
        ? this.processorDecoratorService.decorate(fn)
        : fn;

    for (const wrapper of wrappers) {
      const ctor = resolveWrapperMetatype(wrapper);
      if (!ctor) continue;

      const processorMeta = MetadataRegistry.get<ProcessorMetadata>(
        QUEUE_PROCESSOR_METADATA,
        ctor,
      );
      if (processorMeta) {
        this.bindProcessor(wrapper, ctor, processorMeta, decorate);
      }

      const listenerMeta = MetadataRegistry.get<QueueEventsListenerOptions>(
        QUEUE_EVENTS_LISTENER_METADATA,
        ctor,
      );
      if (listenerMeta) {
        this.bindQueueEventsListener(wrapper, ctor, listenerMeta);
      }
    }
  }

  private bindProcessor(
    wrapper: InstanceWrapper,
    ctor: Function,
    processorMeta: ProcessorMetadata,
    decorate: <TData = any, TResult = any>(
      fn: JobHandler<TData, TResult>,
    ) => JobHandler<TData, TResult>,
  ): void {
    const queue = this.registry.get(processorMeta.queueName);
    if (!queue) {
      return;
    }

    const concurrency =
      processorMeta.workerOptions?.concurrency ?? processorMeta.concurrency;
    if (concurrency !== undefined) {
      queue.setConcurrency(concurrency);
    }
    if (processorMeta.workerOptions?.groupConcurrency !== undefined) {
      queue.setGroupConcurrency(processorMeta.workerOptions.groupConcurrency);
    }
    if (processorMeta.workerOptions?.limiter !== undefined) {
      queue.setLimiter(processorMeta.workerOptions.limiter);
    }

    const isRequestScoped =
      !wrapper.isDependencyTreeStatic ||
      wrapper.scope === Scope.REQUEST ||
      processorMeta.scope === Scope.REQUEST;

    const processMetas = collectMergedClassArray<ProcessMethodMetadata>(
      QUEUE_PROCESS_METADATA,
      ctor,
    );

    if (isRequestScoped) {
      const hasProcessMethods = processMetas.length > 0;
      const proto = ctor.prototype as Record<string, unknown> | undefined;
      const isWorkerHost =
        proto instanceof WorkerHost || typeof proto?.process === "function";

      if (hasProcessMethods) {
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
          if (meta.jobName !== undefined) {
            queue.process(meta.jobName, bound);
          } else {
            queue.process(bound);
          }
        }
      } else if (isWorkerHost) {
        const bound = decorate(async (job: Job<any, any>, token?: string) => {
          const contextId = ContextIdFactory.create();
          wrapper.moduleRef.registerRequestByContextId(job, contextId);
          const scopedInstance = (await wrapper.moduleRef.resolve(
            wrapper.token,
            contextId,
            { strict: false },
          )) as WorkerHost;
          return await scopedInstance.process(job, token);
        });
        queue.process(bound);
      }
      return;
    }

    const instance = wrapper.instance;
    if (!instance || typeof instance !== "object") {
      return;
    }

    const workerHandle = createQueueWorkerHandle(queue);
    if (instance instanceof WorkerHost) {
      (instance as unknown as { _worker?: BullMQWorkerLike })._worker =
        workerHandle;
    }

    // Legacy @OnQueueEvent on @Processor
    const eventMetas = collectMergedClassArray<QueueEventMetadata>(
      QUEUE_EVENT_METADATA,
      ctor,
    );
    for (const meta of eventMetas) {
      const fn = (instance as Record<string | symbol, unknown>)[
        meta.methodName
      ];
      if (typeof fn === "function") {
        const unbind = queue.on(
          meta.eventName ?? meta.event,
          (job: Job<any, any>, payload?: unknown) =>
            (fn as Function).call(instance, job, payload),
        );
        this.attachedUnbinders.push(unbind);
      }
    }

    // BullMQ v5/v6 @OnWorkerEvent on @Processor
    const workerEventMetas = collectMergedClassArray<WorkerEventMetadata>(
      QUEUE_WORKER_EVENT_METADATA,
      ctor,
    );
    for (const meta of workerEventMetas) {
      const fn = (instance as Record<string | symbol, unknown>)[
        meta.methodName
      ];
      if (typeof fn === "function") {
        const unbind = queue.on(
          meta.eventName,
          (job: Job<any, any>, payload?: unknown) =>
            (fn as Function).call(instance, job, payload),
        );
        this.attachedUnbinders.push(unbind);
      }
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
        if (meta.jobName !== undefined) {
          queue.process(meta.jobName, bound);
        } else {
          queue.process(bound);
        }
      }
    } else if (
      instance instanceof WorkerHost ||
      typeof (instance as { process?: unknown }).process === "function"
    ) {
      const bound = decorate((job: Job<any, any>, token?: string) =>
        (instance as WorkerHost).process(job, token),
      );
      queue.process(bound);
    }
  }

  private bindQueueEventsListener(
    wrapper: InstanceWrapper,
    ctor: Function,
    listenerMeta: QueueEventsListenerOptions,
  ): void {
    const instance = wrapper.instance;
    if (!instance || typeof instance !== "object") {
      return;
    }

    const queueEvents = new QueueEvents(listenerMeta.queueName);
    this.queueEventsInstances.push(queueEvents);

    if (instance instanceof QueueEventsHost) {
      (instance as unknown as { _queueEvents?: QueueEvents })._queueEvents =
        queueEvents;
    }

    const queue = this.registry.get(listenerMeta.queueName);
    if (queue) {
      const unbind = bindQueueToQueueEvents(queue, queueEvents);
      this.attachedUnbinders.push(unbind);
    }

    const eventMetas = collectMergedClassArray<QueueEventMetadata>(
      QUEUE_EVENT_METADATA,
      ctor,
    );
    for (const meta of eventMetas) {
      const fn = (instance as Record<string | symbol, unknown>)[
        meta.methodName
      ];
      if (typeof fn === "function") {
        const listener = (...args: any[]) =>
          (fn as Function).apply(instance, args);
        queueEvents.on(meta.eventName ?? meta.event, listener);
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    // Phase 1: drain active workers while queues remain open.
    await this.registry.closeAllWorkers();
  }

  async onApplicationShutdown(): Promise<void> {
    // Phase 2: close queues, events, listeners, and driver after workers finish draining.
    await this.registry.closeAll();

    for (const qe of this.queueEventsInstances.splice(0)) {
      await qe.close();
    }

    for (const unbind of this.attachedUnbinders) {
      unbind();
    }
    this.attachedUnbinders.length = 0;

    if (this.driver) {
      await this.driver.close();
    }
  }
}

/**
 * Dynamic module configuring queue drivers, named queues, declarative `@Processor`
 * discovery, and graceful shutdown draining.
 */
@Module({})
export class QueueModule {
  static forRoot(options: QueueModuleOptions = {}): DynamicModule {
    const driver = options.driver ?? new MemoryQueueDriver();

    const providers: Provider[] = [
      {
        provide: QUEUE_MODULE_OPTIONS,
        useValue: options,
      },
      {
        provide: QUEUE_DRIVER,
        useValue: driver,
      },
      {
        provide: QUEUE_REGISTRY,
        useClass: QueueRegistry,
      },
      {
        provide: QueueRegistry,
        useExisting: QUEUE_REGISTRY,
      },
      {
        provide: JOB_REF,
        scope: Scope.REQUEST,
        useFactory: (job: unknown) => job,
        inject: [{ token: REQUEST, optional: true }],
      },
      ProcessorDecoratorService,
      QueueExplorer,
    ];

    return {
      module: QueueModule,
      global: options.global ?? true,
      providers,
      exports: [
        QUEUE_MODULE_OPTIONS,
        QUEUE_DRIVER,
        QUEUE_REGISTRY,
        QueueRegistry,
        JOB_REF,
        ProcessorDecoratorService,
      ],
    };
  }

  static forRootAsync(options: QueueModuleAsyncOptions): DynamicModule {
    const asyncProviders: Provider[] = [];

    if (options.useFactory) {
      asyncProviders.push({
        provide: QUEUE_MODULE_OPTIONS,
        useFactory: options.useFactory,
        inject: options.inject ?? [],
      });
    } else if (options.useClass) {
      asyncProviders.push(
        {
          provide: options.useClass,
          useClass: options.useClass,
        },
        {
          provide: QUEUE_MODULE_OPTIONS,
          useFactory: async (factory: QueueModuleOptionsFactory) =>
            await factory.createQueueOptions(),
          inject: [options.useClass],
        },
      );
    } else if (options.useExisting) {
      asyncProviders.push({
        provide: QUEUE_MODULE_OPTIONS,
        useFactory: async (factory: QueueModuleOptionsFactory) =>
          await factory.createQueueOptions(),
        inject: [options.useExisting],
      });
    } else {
      throw new Error(
        "QueueModule.forRootAsync() requires useFactory, useClass, or useExisting.",
      );
    }

    const providers: Provider[] = [
      ...asyncProviders,
      ...(options.extraProviders ?? []),
      {
        provide: QUEUE_DRIVER,
        useFactory: (opts: QueueModuleOptions) =>
          opts?.driver ?? new MemoryQueueDriver(),
        inject: [QUEUE_MODULE_OPTIONS],
      },
      {
        provide: QUEUE_REGISTRY,
        useClass: QueueRegistry,
      },
      {
        provide: QueueRegistry,
        useExisting: QUEUE_REGISTRY,
      },
      {
        provide: JOB_REF,
        scope: Scope.REQUEST,
        useFactory: (job: unknown) => job,
        inject: [{ token: REQUEST, optional: true }],
      },
      ProcessorDecoratorService,
      QueueExplorer,
    ];

    return {
      module: QueueModule,
      global: options.global ?? true,
      imports: options.imports ?? [],
      providers,
      exports: [
        QUEUE_MODULE_OPTIONS,
        QUEUE_DRIVER,
        QUEUE_REGISTRY,
        QueueRegistry,
        JOB_REF,
        ProcessorDecoratorService,
      ],
    };
  }

  static registerQueue(...configs: QueueConfig[]): DynamicModule {
    const providers: Provider[] = [];
    const exportsList: ModuleExport[] = [];

    for (const config of configs) {
      const token = getQueueToken(config.name);
      providers.push({
        provide: token,
        useFactory: (
          rootDriver?: QueueDriver,
          rootOptions?: QueueModuleOptions,
          registry?: QueueRegistry,
          clsService?: ClsService,
        ) => {
          const queue = new Queue({
            ...config,
            driver: config.driver ?? rootDriver ?? new MemoryQueueDriver(),
            clsService:
              config.clsService ?? rootOptions?.clsService ?? clsService,
            clsKeys: config.clsKeys ?? rootOptions?.clsKeys,
            defaultJobOptions: {
              ...rootOptions?.defaultJobOptions,
              ...config.defaultJobOptions,
            },
            shutdownTimeoutMs:
              config.shutdownTimeoutMs ?? rootOptions?.shutdownTimeoutMs,
          });
          registry?.register(queue);
          return queue;
        },
        inject: [
          { token: QUEUE_DRIVER, optional: true },
          { token: QUEUE_MODULE_OPTIONS, optional: true },
          { token: QUEUE_REGISTRY, optional: true },
          { token: ClsService, optional: true },
        ],
      });
      exportsList.push(token);
    }

    return {
      module: QueueModule,
      providers,
      exports: exportsList,
    };
  }

  static registerQueueAsync(
    ...configs: RegisterQueueConfigAsyncOptions[]
  ): DynamicModule {
    const providers: Provider[] = [];
    const exportsList: ModuleExport[] = [];
    const importsSet = new Set<any>();

    for (const config of configs) {
      for (const imp of config.imports ?? []) {
        importsSet.add(imp);
      }
      if (config.extraProviders) {
        providers.push(...config.extraProviders);
      }

      const optionsToken = getQueueOptionsToken(config.name);
      if (config.useFactory) {
        providers.push({
          provide: optionsToken,
          useFactory: config.useFactory,
          inject: config.inject ?? [],
        });
      } else if (config.useClass) {
        providers.push(
          { provide: config.useClass, useClass: config.useClass },
          {
            provide: optionsToken,
            useFactory: async (factory: {
              createQueueConfig(): Promise<QueueConfig> | QueueConfig;
            }) => await factory.createQueueConfig(),
            inject: [config.useClass],
          },
        );
      } else if (config.useExisting) {
        providers.push({
          provide: optionsToken,
          useFactory: async (factory: {
            createQueueConfig(): Promise<QueueConfig> | QueueConfig;
          }) => await factory.createQueueConfig(),
          inject: [config.useExisting],
        });
      } else {
        throw new Error(
          `QueueModule.registerQueueAsync("${config.name}") requires useFactory, useClass, or useExisting.`,
        );
      }

      const token = getQueueToken(config.name);
      providers.push({
        provide: token,
        useFactory: (
          resolvedConfig: Omit<QueueConfig, "name"> & { name?: string },
          rootDriver?: QueueDriver,
          rootOptions?: QueueModuleOptions,
          registry?: QueueRegistry,
          clsService?: ClsService,
        ) => {
          const queue = new Queue({
            ...resolvedConfig,
            name: resolvedConfig?.name ?? config.name,
            driver:
              resolvedConfig?.driver ?? rootDriver ?? new MemoryQueueDriver(),
            clsService:
              resolvedConfig?.clsService ??
              rootOptions?.clsService ??
              clsService,
            clsKeys: resolvedConfig?.clsKeys ?? rootOptions?.clsKeys,
            defaultJobOptions: {
              ...rootOptions?.defaultJobOptions,
              ...resolvedConfig?.defaultJobOptions,
            },
            shutdownTimeoutMs:
              resolvedConfig?.shutdownTimeoutMs ??
              rootOptions?.shutdownTimeoutMs,
          });
          registry?.register(queue);
          return queue;
        },
        inject: [
          optionsToken,
          { token: QUEUE_DRIVER, optional: true },
          { token: QUEUE_MODULE_OPTIONS, optional: true },
          { token: QUEUE_REGISTRY, optional: true },
          { token: ClsService, optional: true },
        ],
      });
      exportsList.push(token);
    }

    return {
      module: QueueModule,
      imports: [...importsSet],
      providers,
      exports: exportsList,
    };
  }
}
