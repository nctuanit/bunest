import {
  ClsService,
  Injectable,
  Module,
  type BeforeApplicationShutdown,
  type DynamicModule,
  type ModuleExport,
  type OnModuleDestroy,
  type OnModuleInit,
  type Provider,
} from "@bunest/core";
import { WorkerOffloadAspect } from "./decorators";
import type {
  RegisterWorkerPoolAsyncOptions,
  RegisterWorkerPoolOptionsFactory,
  WorkerModuleAsyncOptions,
  WorkerModuleOptions,
  WorkerModuleOptionsFactory,
  WorkerPoolHealthSnapshot,
  WorkerPoolOptions,
} from "./interfaces";
import {
  WORKER_MODULE_OPTIONS,
  WORKER_OFFLOAD_ASPECT,
  WORKER_POOL_REGISTRY,
  getWorkerPoolOptionsToken,
  getWorkerPoolToken,
} from "./tokens";
import { WorkerPool } from "./worker-pool";

/**
 * Central registry tracking all DI-managed `WorkerPool` instances for
 * `@Offload()`, health indicators, warm-up on `onModuleInit`, and graceful
 * draining during application shutdown.
 */
@Injectable()
export class WorkerPoolRegistry
  implements OnModuleInit, BeforeApplicationShutdown, OnModuleDestroy
{
  private readonly pools = new Map<string, WorkerPool>();
  private readonly warmUpPools = new Set<string>();
  private shutdownPromise?: Promise<void>;

  register(pool: WorkerPool, options?: { readonly warmUp?: boolean }): void {
    this.pools.set(pool.name, pool);
    if (options?.warmUp) {
      this.warmUpPools.add(pool.name);
    }
  }

  get(name = "default"): WorkerPool | undefined {
    return this.pools.get(name);
  }

  has(name = "default"): boolean {
    return this.pools.has(name);
  }

  getAll(): WorkerPool[] {
    return [...this.pools.values()];
  }

  getHealthSnapshots(): WorkerPoolHealthSnapshot[] {
    return [...this.pools.values()].map((pool) => pool.getHealthSnapshot());
  }

  async warmUpAll(): Promise<void> {
    const targets: Promise<void>[] = [];
    for (const poolName of this.warmUpPools) {
      const pool = this.pools.get(poolName);
      if (pool && !pool.isClosed) {
        targets.push(pool.warmUp(Math.max(1, pool.minThreads)));
      }
    }
    if (targets.length > 0) {
      await Promise.all(targets);
    }
  }

  async onModuleInit(): Promise<void> {
    await this.warmUpAll();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.closeAll();
  }

  async onModuleDestroy(): Promise<void> {
    await this.closeAll();
  }

  async closeAll(options?: {
    readonly force?: boolean;
    readonly timeoutMs?: number;
  }): Promise<void> {
    if (this.shutdownPromise && !options?.force) {
      return this.shutdownPromise;
    }
    const allPools = [...this.pools.values()];
    this.shutdownPromise = (async () => {
      await Promise.allSettled(allPools.map((pool) => pool.close(options)));
      this.pools.clear();
      this.warmUpPools.clear();
    })();
    return this.shutdownPromise;
  }
}

function createManagedPool(
  config: WorkerPoolOptions,
  rootOptions?: WorkerModuleOptions,
  registry?: WorkerPoolRegistry,
  clsService?: ClsService,
): WorkerPool {
  const defaults = rootOptions?.defaultPoolOptions;
  const merged: WorkerPoolOptions = {
    ...defaults,
    ...config,
    name: config.name ?? "default",
    clsService: config.clsService ?? defaults?.clsService ?? clsService,
    clsKeys: config.clsKeys ?? defaults?.clsKeys,
  };
  const pool = new WorkerPool(merged);
  registry?.register(pool, { warmUp: merged.warmUp === true });
  return pool;
}

/**
 * Dynamic Bunest module for managing multi-threaded Bun `WorkerPool` instances,
 * DI injection (`@InjectWorkerPool`), service-layer AOP (`@Offload`), and
 * automatic graceful shutdown.
 */
@Module({})
export class WorkerModule {
  static forRoot(options: WorkerModuleOptions = {}): DynamicModule {
    const providers: Provider[] = [
      {
        provide: WORKER_MODULE_OPTIONS,
        useValue: options,
      },
      {
        provide: WORKER_POOL_REGISTRY,
        useClass: WorkerPoolRegistry,
      },
      {
        provide: WorkerPoolRegistry,
        useExisting: WORKER_POOL_REGISTRY,
      },
      WorkerOffloadAspect,
      {
        provide: WORKER_OFFLOAD_ASPECT,
        useExisting: WorkerOffloadAspect,
      },
    ];

    const exportsList: ModuleExport[] = [
      WORKER_MODULE_OPTIONS,
      WORKER_POOL_REGISTRY,
      WorkerPoolRegistry,
      WorkerOffloadAspect,
      WORKER_OFFLOAD_ASPECT,
    ];

    if (options.pools && options.pools.length > 0) {
      for (const poolConfig of options.pools) {
        const token = getWorkerPoolToken(poolConfig.name);
        providers.push({
          provide: token,
          useFactory: (
            registry: WorkerPoolRegistry,
            clsService?: ClsService,
          ) => createManagedPool(poolConfig, options, registry, clsService),
          inject: [
            WORKER_POOL_REGISTRY,
            { token: ClsService, optional: true },
          ],
        });
        exportsList.push(token);
      }
    }

    return {
      module: WorkerModule,
      global: options.global ?? true,
      providers,
      exports: exportsList,
    };
  }

  static forRootAsync(options: WorkerModuleAsyncOptions): DynamicModule {
    const asyncProviders: Provider[] = [];

    if (options.useFactory) {
      asyncProviders.push({
        provide: WORKER_MODULE_OPTIONS,
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
          provide: WORKER_MODULE_OPTIONS,
          useFactory: async (factory: WorkerModuleOptionsFactory) =>
            await factory.createWorkerModuleOptions(),
          inject: [options.useClass],
        },
      );
    } else if (options.useExisting) {
      asyncProviders.push({
        provide: WORKER_MODULE_OPTIONS,
        useFactory: async (factory: WorkerModuleOptionsFactory) =>
          await factory.createWorkerModuleOptions(),
        inject: [options.useExisting],
      });
    } else {
      throw new Error(
        "WorkerModule.forRootAsync() requires useFactory, useClass, or useExisting.",
      );
    }

    const providers: Provider[] = [
      ...asyncProviders,
      ...(options.extraProviders ?? []),
      {
        provide: WORKER_POOL_REGISTRY,
        useClass: WorkerPoolRegistry,
      },
      {
        provide: WorkerPoolRegistry,
        useExisting: WORKER_POOL_REGISTRY,
      },
      WorkerOffloadAspect,
      {
        provide: WORKER_OFFLOAD_ASPECT,
        useExisting: WorkerOffloadAspect,
      },
    ];

    return {
      module: WorkerModule,
      global: options.global ?? true,
      imports: options.imports ?? [],
      providers,
      exports: [
        WORKER_MODULE_OPTIONS,
        WORKER_POOL_REGISTRY,
        WorkerPoolRegistry,
        WorkerOffloadAspect,
        WORKER_OFFLOAD_ASPECT,
      ],
    };
  }

  static registerPool(...configs: WorkerPoolOptions[]): DynamicModule {
    const providers: Provider[] = [];
    const exportsList: ModuleExport[] = [];

    for (const config of configs) {
      const token = getWorkerPoolToken(config.name);
      providers.push({
        provide: token,
        useFactory: (
          rootOptions?: WorkerModuleOptions,
          registry?: WorkerPoolRegistry,
          clsService?: ClsService,
        ) => createManagedPool(config, rootOptions, registry, clsService),
        inject: [
          { token: WORKER_MODULE_OPTIONS, optional: true },
          { token: WORKER_POOL_REGISTRY, optional: true },
          { token: ClsService, optional: true },
        ],
      });
      exportsList.push(token);
    }

    return {
      module: WorkerModule,
      providers,
      exports: exportsList,
    };
  }

  static registerPoolAsync(
    ...configs: RegisterWorkerPoolAsyncOptions[]
  ): DynamicModule {
    const providers: Provider[] = [];
    const exportsList: ModuleExport[] = [];
    const importsSet = new Set<any>();

    for (const config of configs) {
      if (config.imports) {
        for (const imp of config.imports) {
          importsSet.add(imp);
        }
      }
      if (config.extraProviders) {
        providers.push(...config.extraProviders);
      }

      const optsToken = getWorkerPoolOptionsToken(config.name);
      const poolToken = getWorkerPoolToken(config.name);

      if (config.useFactory) {
        providers.push({
          provide: optsToken,
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
            provide: optsToken,
            useFactory: async (factory: RegisterWorkerPoolOptionsFactory) =>
              await factory.createWorkerPoolOptions(),
            inject: [config.useClass],
          },
        );
      } else if (config.useExisting) {
        providers.push({
          provide: optsToken,
          useFactory: async (factory: RegisterWorkerPoolOptionsFactory) =>
            await factory.createWorkerPoolOptions(),
          inject: [config.useExisting],
        });
      } else {
        throw new Error(
          `WorkerModule.registerPoolAsync("${config.name}") requires useFactory, useClass, or useExisting.`,
        );
      }

      providers.push({
        provide: poolToken,
        useFactory: (
          poolOpts: Omit<WorkerPoolOptions, "name">,
          rootOptions?: WorkerModuleOptions,
          registry?: WorkerPoolRegistry,
          clsService?: ClsService,
        ) =>
          createManagedPool(
            { ...poolOpts, name: config.name },
            rootOptions,
            registry,
            clsService,
          ),
        inject: [
          optsToken,
          { token: WORKER_MODULE_OPTIONS, optional: true },
          { token: WORKER_POOL_REGISTRY, optional: true },
          { token: ClsService, optional: true },
        ],
      });
      exportsList.push(poolToken);
    }

    return {
      module: WorkerModule,
      imports: [...importsSet],
      providers,
      exports: exportsList,
    };
  }
}
