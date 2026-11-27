import {
  ClsService,
  DiscoveryService,
  Inject,
  Injectable,
  Logger,
  ModuleRef,
  Optional,
  restoreClsContext,
  type InstanceWrapper,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@bunest/core";
import { SCHEDULE_MODULE_OPTIONS } from "./constants";
import { CronJob } from "./cron/cron-job";
import {
  getCronMetadata,
  getIntervalMetadata,
  getTimeoutMetadata,
} from "./decorators/schedule.decorators";
import type { ScheduleModuleOptions } from "./interfaces/scheduler.interface";
import {
  SCHEDULER_LOCK_DRIVER,
  type SchedulerLockDriver,
} from "./scheduler-lock";
import { SchedulerRegistry } from "./scheduler.registry";

/**
 * Discovers `@Cron()`, `@Interval()`, and `@Timeout()` methods across all
 * loaded module providers and controllers, respects `ScheduleModuleOptions`
 * toggles (`cronJobs`, `intervals`, `timeouts`) and `initialDelay`, warns on
 * non-static providers, and stops every timer cleanly on shutdown.
 */
@Injectable()
export class SchedulerExplorer
  implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  private autoCounter = 0;
  private explored = false;
  private readonly initialDelayTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly logger = new Logger("Scheduler");

  constructor(
    private readonly registry: SchedulerRegistry,
    private readonly moduleRef: ModuleRef,
    @Optional()
    private readonly discoveryService?: DiscoveryService,
    @Optional()
    @Inject(SCHEDULE_MODULE_OPTIONS)
    private readonly moduleOptions: ScheduleModuleOptions = {},
    @Optional()
    @Inject(SCHEDULER_LOCK_DRIVER)
    private readonly lockDriver?: SchedulerLockDriver,
    @Optional()
    private readonly clsService?: ClsService,
  ) {}

  onModuleInit(): void {
    this.explore();
  }

  onApplicationBootstrap(): void {
    if (!this.explored) {
      this.explore();
    }
  }

  onModuleDestroy(): void {
    for (const timer of this.initialDelayTimers.values()) {
      clearTimeout(timer);
    }
    this.initialDelayTimers.clear();
    this.explored = false;
  }

  explore(): void {
    if (this.explored) {
      return;
    }
    this.explored = true;

    const discovery = this.resolveDiscoveryService();
    if (!discovery) {
      return;
    }

    const seenInstances = new Set<object>();
    const seenNonStatic = new Set<string>();
    const wrappers: InstanceWrapper[] = [
      ...discovery.getControllers(),
      ...discovery.getProviders(),
    ];

    for (const wrapper of wrappers) {
      if (wrapper.instance === this) {
        continue;
      }

      if (wrapper.isDependencyTreeStatic) {
        const instance = wrapper.instance;
        if (
          !instance ||
          typeof instance !== "object" ||
          seenInstances.has(instance)
        ) {
          continue;
        }
        seenInstances.add(instance);
        this.registerJobsFromInstance(instance);
        continue;
      }

      const ctor =
        typeof wrapper.metatype === "function"
          ? wrapper.metatype
          : wrapper.instance && typeof wrapper.instance === "object"
            ? wrapper.instance.constructor
            : undefined;
      if (typeof ctor !== "function" || ctor === Object) {
        continue;
      }

      const keyId = `${wrapper.moduleId}:${typeof wrapper.token === "function" ? wrapper.token.name : String(wrapper.token)}`;
      if (seenNonStatic.has(keyId)) {
        continue;
      }
      seenNonStatic.add(keyId);

      const targetObj = (
        wrapper.instance && typeof wrapper.instance === "object"
          ? wrapper.instance
          : ctor.prototype
      ) as Record<string, unknown>;
      const methodKeys = new Set<string | symbol>([
        ...getCronMetadata(ctor).map((m) => m.methodName),
        ...getIntervalMetadata(ctor).map((m) => m.methodName),
        ...getTimeoutMetadata(ctor).map((m) => m.methodName),
      ]);

      for (const methodKey of methodKeys) {
        this.warnForNonStaticProviders(wrapper, targetObj, String(methodKey));
      }
    }
  }

  lookupSchedulers(
    instance: Record<string | symbol, unknown>,
    key: string | symbol,
  ): void {
    const ctor = instance?.constructor;
    if (typeof ctor !== "function" || ctor === Object) {
      return;
    }

    const fn = instance[key];
    if (typeof fn !== "function") {
      return;
    }

    const className = ctor.name || "Anonymous";
    const cronEnabled = this.moduleOptions.cronJobs !== false;
    const intervalsEnabled = this.moduleOptions.intervals !== false;
    const timeoutsEnabled = this.moduleOptions.timeouts !== false;

    if (cronEnabled) {
      for (const cronMeta of getCronMetadata(ctor)) {
        if (cronMeta.methodName !== key) {
          continue;
        }
        const name =
          cronMeta.options.name ??
          `${className}.${String(cronMeta.methodName)}#cron_${++this.autoCounter}`;
        const resolvedLockDriver =
          cronMeta.options.lockDriver ??
          this.lockDriver ??
          this.moduleOptions.lockDriver;
        const effectiveLockConfig =
          cronMeta.options.lock === false
            ? undefined
            : cronMeta.options.lock ??
              (this.moduleOptions.defaultLock &&
              typeof this.moduleOptions.defaultLock === "object"
                ? this.moduleOptions.defaultLock
                : undefined);
        const resolvedLock = effectiveLockConfig
          ? {
              ...effectiveLockConfig,
              key:
                effectiveLockConfig.key ??
                cronMeta.options.name ??
                `${className}.${String(cronMeta.methodName)}`,
            }
          : undefined;
        const job = new CronJob(
          cronMeta.expression,
          this.wrapWithCleanCls("cron", name, () =>
            (fn as () => unknown).call(instance),
          ),
          {
            ...cronMeta.options,
            name,
            lock: resolvedLock,
            ...(resolvedLockDriver ? { lockDriver: resolvedLockDriver } : {}),
          },
        );
        this.registry.addCronJob(name, job);
        this.startCronJob(name, job, cronMeta.options);
      }
    }

    if (intervalsEnabled) {
      for (const intervalMeta of getIntervalMetadata(ctor)) {
        if (intervalMeta.methodName !== key) {
          continue;
        }
        const name =
          intervalMeta.options.name ??
          `${className}.${String(intervalMeta.methodName)}#interval_${++this.autoCounter}`;
        this.registry.scheduleInterval(
          name,
          intervalMeta.timeoutMs,
          this.wrapWithCleanCls("interval", name, () =>
            (fn as () => unknown).call(instance),
          ),
          intervalMeta.options,
        );
      }
    }

    if (timeoutsEnabled) {
      for (const timeoutMeta of getTimeoutMetadata(ctor)) {
        if (timeoutMeta.methodName !== key) {
          continue;
        }
        const name =
          timeoutMeta.options.name ??
          `${className}.${String(timeoutMeta.methodName)}#timeout_${++this.autoCounter}`;
        this.registry.scheduleTimeout(
          name,
          timeoutMeta.timeoutMs,
          this.wrapWithCleanCls("timeout", name, () =>
            (fn as () => unknown).call(instance),
          ),
          timeoutMeta.options,
        );
      }
    }
  }

  warnForNonStaticProviders(
    wrapper: InstanceWrapper<any>,
    instance: Record<string | symbol, unknown>,
    key: string,
  ): void {
    const ctor =
      typeof wrapper.metatype === "function"
        ? wrapper.metatype
        : instance?.constructor;
    if (typeof ctor !== "function" || ctor === Object) {
      return;
    }

    const providerName =
      typeof wrapper.token === "function"
        ? wrapper.token.name
        : String(wrapper.token);

    if (
      this.moduleOptions.cronJobs !== false &&
      getCronMetadata(ctor).some((m) => String(m.methodName) === key)
    ) {
      this.logger.warn(
        `Cannot register cron job "${providerName}@${key}" because it is defined in a non static provider.`,
      );
    }

    if (
      this.moduleOptions.timeouts !== false &&
      getTimeoutMetadata(ctor).some((m) => String(m.methodName) === key)
    ) {
      this.logger.warn(
        `Cannot register timeout "${providerName}@${key}" because it is defined in a non static provider.`,
      );
    }

    if (
      this.moduleOptions.intervals !== false &&
      getIntervalMetadata(ctor).some((m) => String(m.methodName) === key)
    ) {
      this.logger.warn(
        `Cannot register interval "${providerName}@${key}" because it is defined in a non static provider.`,
      );
    }
  }

  registerJobsFromInstance(instance: object): void {
    const ctor = instance.constructor;
    if (typeof ctor !== "function" || ctor === Object) {
      return;
    }

    const record = instance as Record<string | symbol, unknown>;
    const methodKeys = new Set<string | symbol>([
      ...getCronMetadata(ctor).map((m) => m.methodName),
      ...getIntervalMetadata(ctor).map((m) => m.methodName),
      ...getTimeoutMetadata(ctor).map((m) => m.methodName),
    ]);

    for (const key of methodKeys) {
      this.lookupSchedulers(record, key);
    }
  }

  private startCronJob(
    name: string,
    job: CronJob,
    options: {
      disabled?: boolean;
      initialDelay?: number;
      unrefTimeout?: boolean;
      unref?: boolean;
    },
  ): void {
    if (options.disabled) {
      return;
    }

    if (options.initialDelay !== undefined && options.initialDelay > 0) {
      const delayTimer = setTimeout(() => {
        this.initialDelayTimers.delete(name);
        if (
          this.registry.doesExist("cron", name) &&
          this.registry.getCronJob(name) === job
        ) {
          job.start();
        }
      }, options.initialDelay);

      if ((options.unrefTimeout ?? options.unref ?? true) !== false) {
        delayTimer.unref?.();
      }
      this.initialDelayTimers.set(name, delayTimer);
      return;
    }

    job.start();
  }

  private wrapWithCleanCls(
    kind: "cron" | "interval" | "timeout",
    jobName: string,
    callback: () => unknown | Promise<unknown>,
  ): () => unknown | Promise<unknown> {
    return () => {
      const cls = this.resolveClsService();
      if (!cls) {
        return callback();
      }
      const requestId = `${kind}:${jobName}:${crypto.randomUUID()}`;
      return restoreClsContext(
        cls,
        {
          clsId: requestId,
          values: {
            requestId,
            jobName,
          },
        },
        callback,
      );
    };
  }

  private resolveClsService(): ClsService | undefined {
    let cls = this.clsService;
    if (!cls && this.moduleRef) {
      try {
        cls = this.moduleRef.get(ClsService, { strict: false });
      } catch {
        cls = undefined;
      }
    }
    return cls;
  }

  private resolveDiscoveryService(): DiscoveryService | undefined {
    let discovery = this.discoveryService;
    if (!discovery && this.moduleRef) {
      try {
        discovery = this.moduleRef.get(DiscoveryService, { strict: false });
      } catch {
        discovery = undefined;
      }
    }
    return discovery;
  }
}
