import {
  AutoModule,
  Logger,
  type AutoDiscoverOptions,
  type LoggerService,
  type MicroserviceInstance,
  type ModuleExport,
  type ModuleImport,
  type Provider,
  type Type,
  type WebSocketAdapter,
} from "../common/index";
import {
  extractCallerDir,
  type AutoModuleManifestLoader,
} from "../common/decorators/core.decorators";
import { BunHttpAdapter, type BunServerLike } from "../http/index";
import { DIContainer } from "../di/di-container";
import type {
  BunestApplicationContextOptions,
  ContainerOverrides,
  IEntryNestModule,
} from "../interfaces/core-types.interface";
import { expandAutoModules, ModuleScanner } from "../module/module-scanner";
import { BunestApplication } from "./bunest-application";
import { BunestApplicationContext } from "./bunest-application-context";

export interface BunestCreateOptions extends BunestApplicationContextOptions {
  overrides?: ContainerOverrides;
  httpAdapter?: BunHttpAdapter;
}

export interface BunestCreateAutoOptions extends BunestCreateOptions {
  readonly imports?: ModuleImport[];
  readonly controllers?: Type<any>[];
  readonly providers?: Provider[];
  readonly exports?: ModuleExport[];
  readonly autoDiscover?: boolean | AutoDiscoverOptions;
  readonly scan?: string | readonly string[];
  readonly exclude?: readonly string[];
  readonly cwd?: string;
  readonly manifest?: readonly AutoModuleManifestLoader[];
  readonly filter?: (target: Type<unknown>) => boolean;
}

export interface BunestFetchHandlerOptions extends BunestCreateOptions {
  /**
   * Optional one-time configuration callback invoked after `BunestFactory.create()`
   * and before `app.init()` / the first incoming request is handled.
   */
  readonly configure?: (app: BunestApplication) => void | Promise<void>;
}

/**
 * Serverless / edge Web Fetch entrypoint created by `BunestFactory.createFetchHandler()`.
 * Lazily bootstraps the `BunestApplication` on first request using single-flight
 * deduplication so concurrent cold-start requests share one initialization.
 */
export interface BunestFetchHandler {
  (req: Request, server?: unknown): Promise<Response>;
  /**
   * Triggers or awaits the single-flight cold-start bootstrap and returns the ready app.
   */
  readonly ready: () => Promise<BunestApplication>;
  /**
   * Gracefully shuts down the lazily bootstrapped application (if initialized or in flight).
   */
  readonly close: (signal?: string) => Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

function isHttpAdapterInstance(value: unknown): value is BunHttpAdapter {
  return (
    value instanceof BunHttpAdapter ||
    (typeof value === "object" &&
      value !== null &&
      typeof (value as Partial<BunHttpAdapter>).compileControllers ===
        "function" &&
      typeof (value as Partial<BunHttpAdapter>).fetch === "function")
  );
}

export type MicroserviceServerFactory<
  T extends MicroserviceInstance = MicroserviceInstance,
> = T | ((context: BunestApplicationContext) => T | Promise<T>);

/**
 * Standalone microservice application created via `BunestFactory.createMicroservice()`,
 * uniting DI/Modules/Lifecycle with any `MicroserviceInstance` transport server
 * (e.g. `TcpServer`, `GrpcServer`, `KafkaServer`, `MqttServer`, or `MicroserviceHost`).
 */
export class BunestMicroserviceApplication<
  T extends MicroserviceInstance = MicroserviceInstance,
> extends BunestApplicationContext {
  private started = false;
  private pendingStopPromise?: Promise<void>;

  constructor(
    container: DIContainer,
    private readonly microservice: T,
    options: BunestApplicationContextOptions = {},
  ) {
    super(container, options);
  }

  getServer(): T {
    return this.microservice;
  }

  useWebSocketAdapter(adapter: WebSocketAdapter): this {
    this.container.getApplicationConfig().setIoAdapter(adapter);
    for (const group of this.container.getSingletonInstancesByModule()) {
      for (const instance of group.instances) {
        if (
          instance !== null &&
          typeof instance === "object" &&
          typeof (instance as { discoverAndBindGateways?: unknown })
            .discoverAndBindGateways === "function" &&
          "adapter" in instance
        ) {
          (instance as { adapter: unknown }).adapter = adapter;
        }
      }
    }
    return this;
  }

  async listen(): Promise<void> {
    await this.init();
    if (this.started) {
      return;
    }
    await this.microservice.listen();
    this.started = true;
  }

  protected override prepareClose(): Promise<void> {
    if (this.started && !this.pendingStopPromise) {
      this.pendingStopPromise = Promise.resolve(this.microservice.close());
    }
    return Promise.resolve();
  }

  protected override async stopTransport(): Promise<void> {
    if (!this.started && !this.pendingStopPromise) {
      return;
    }
    const stopPromise =
      this.pendingStopPromise ?? Promise.resolve(this.microservice.close());
    this.pendingStopPromise = undefined;
    try {
      await stopPromise;
    } finally {
      this.started = false;
    }
  }
}

function logBootstrapError(
  err: unknown,
  options: BunestApplicationContextOptions,
): void {
  if (options.logger === false) {
    return;
  }
  let logger: LoggerService;
  if (
    options.logger &&
    typeof options.logger === "object" &&
    !Array.isArray(options.logger)
  ) {
    logger = options.logger;
  } else if (Array.isArray(options.logger)) {
    logger = new Logger("BunestFactory", { levels: options.logger });
  } else {
    logger = new Logger("BunestFactory");
  }
  if (err instanceof Error) {
    logger.error(err.message, err.stack);
  } else {
    logger.error(String(err));
  }
}

/**
 * Primary entrypoint for bootstrapping Bunest HTTP applications and
 * standalone DI application contexts.
 */
export class BunestFactory {
  static async create(
    rootModule: IEntryNestModule,
    options?: BunestCreateOptions,
  ): Promise<BunestApplication>;
  static async create(
    rootModule: IEntryNestModule,
    httpAdapter: BunHttpAdapter,
    options?: BunestCreateOptions,
  ): Promise<BunestApplication>;
  static async create(
    rootModule: IEntryNestModule,
    adapterOrOptions?: BunHttpAdapter | BunestCreateOptions,
    maybeOptions?: BunestCreateOptions,
  ): Promise<BunestApplication> {
    const hasExplicitAdapter = isHttpAdapterInstance(adapterOrOptions);
    const httpAdapter = hasExplicitAdapter
      ? adapterOrOptions
      : adapterOrOptions?.httpAdapter;
    const options: BunestCreateOptions = hasExplicitAdapter
      ? (maybeOptions ?? {})
      : (adapterOrOptions ?? {});

    try {
      const expandedAutoModules = await expandAutoModules(
        rootModule,
        options.overrides?.modules,
      );
      const scanner = new ModuleScanner();
      const graph = await scanner.scan(rootModule, {
        moduleOverrides: options.overrides?.modules,
        moduleIdGeneratorAlgorithm: options.moduleIdGeneratorAlgorithm,
        expandedAutoModules,
      });
      const container = new DIContainer(graph, {
        preview: options.preview,
        snapshot: options.snapshot,
        instrument: options.instrument,
      });

      if (options.overrides) {
        container.applyOverrides(options.overrides);
      }

      await container.initialize();

      const app = new BunestApplication(container, options, httpAdapter);
      if (!options.preview) {
        await app.prepareHttpPipeline();
      }
      return app;
    } catch (err) {
      if (options.abortOnError === false) {
        logBootstrapError(err, options);
      }
      throw err;
    }
  }

  /**
   * Zero-boilerplate application bootstrap: creates an auto-discovering root
   * `@AutoModule` that wires self-registered `@Controller` and `@Injectable`
   * classes from `DecoratorRegistry` (or scoped `scan` / `manifest`) and returns
   * a ready `BunestApplication`.
   */
  static async createAuto(
    options: BunestCreateAutoOptions = {},
  ): Promise<BunestApplication> {
    const {
      imports,
      controllers,
      providers,
      exports: moduleExports,
      autoDiscover,
      scan,
      exclude,
      cwd,
      manifest,
      filter,
      ...createOptions
    } = options;

    const resolvedCwd =
      cwd !== undefined
        ? cwd
        : scan !== undefined
          ? extractCallerDir()
          : undefined;

    @AutoModule({
      ...(imports !== undefined ? { imports } : {}),
      ...(controllers !== undefined ? { controllers } : {}),
      ...(providers !== undefined ? { providers } : {}),
      ...(moduleExports !== undefined ? { exports: moduleExports } : {}),
      ...(scan !== undefined ? { scan } : {}),
      ...(exclude !== undefined ? { exclude } : {}),
      ...(resolvedCwd !== undefined ? { cwd: resolvedCwd } : {}),
      ...(manifest !== undefined ? { manifest } : {}),
      ...(filter !== undefined ? { filter } : {}),
      autoDiscover: autoDiscover ?? true,
    })
    class AutoRootModule {}

    return BunestFactory.create(AutoRootModule, createOptions);
  }

  static async createApplicationContext(
    rootModule: IEntryNestModule,
    options: Omit<BunestCreateOptions, "httpAdapter"> = {},
  ): Promise<BunestApplicationContext> {
    try {
      const expandedAutoModules = await expandAutoModules(
        rootModule,
        options.overrides?.modules,
      );
      const scanner = new ModuleScanner();
      const graph = await scanner.scan(rootModule, {
        moduleOverrides: options.overrides?.modules,
        moduleIdGeneratorAlgorithm: options.moduleIdGeneratorAlgorithm,
        expandedAutoModules,
      });
      const container = new DIContainer(graph, {
        preview: options.preview,
        snapshot: options.snapshot,
        instrument: options.instrument,
      });

      if (options.overrides) {
        container.applyOverrides(options.overrides);
      }

      await container.initialize();

      const ctx = new BunestApplicationContext(container, options);
      if (!options.preview) {
        await ctx.init();
      }
      return ctx;
    } catch (err) {
      if (options.abortOnError === false) {
        logBootstrapError(err, options);
      }
      throw err;
    }
  }

  /**
   * Bootstraps a standalone microservice application (no HTTP server) using any
   * `MicroserviceInstance` server or factory callback receiving the initialized
   * `BunestApplicationContext`, keeping `@bunest/core` decoupled from transport packages.
   */
  static async createMicroservice<
    T extends MicroserviceInstance = MicroserviceInstance,
  >(
    rootModule: IEntryNestModule,
    serverOrFactory: MicroserviceServerFactory<T>,
    options: Omit<BunestCreateOptions, "httpAdapter"> = {},
  ): Promise<BunestMicroserviceApplication<T>> {
    try {
      const expandedAutoModules = await expandAutoModules(
        rootModule,
        options.overrides?.modules,
      );
      const scanner = new ModuleScanner();
      const graph = await scanner.scan(rootModule, {
        moduleOverrides: options.overrides?.modules,
        moduleIdGeneratorAlgorithm: options.moduleIdGeneratorAlgorithm,
        expandedAutoModules,
      });
      const container = new DIContainer(graph, {
        preview: options.preview,
        snapshot: options.snapshot,
        instrument: options.instrument,
      });

      if (options.overrides) {
        container.applyOverrides(options.overrides);
      }

      await container.initialize();

      const tempCtx = new BunestApplicationContext(container, options);
      const server =
        typeof serverOrFactory === "function"
          ? await serverOrFactory(tempCtx)
          : serverOrFactory;

      if (
        !server ||
        typeof server.listen !== "function" ||
        typeof server.close !== "function"
      ) {
        throw new TypeError(
          "BunestFactory.createMicroservice() requires a MicroserviceInstance implementing { listen(), close() }.",
        );
      }

      return new BunestMicroserviceApplication<T>(container, server, options);
    } catch (err) {
      if (options.abortOnError === false) {
        logBootstrapError(err, options);
      }
      throw err;
    }
  }

  /**
   * Creates a serverless / edge Fetch handler `(req: Request, server?: unknown) => Promise<Response>`
   * that lazily bootstraps `rootModule` on the first request with single-flight deduplication,
   * making concurrent cold-start traffic safe while exposing `.ready()`, `.close()`, and
   * `Symbol.asyncDispose` for graceful teardown.
   */
  static createFetchHandler(
    rootModule: IEntryNestModule,
    options: BunestFetchHandlerOptions = {},
  ): BunestFetchHandler {
    const { configure, ...createOptions } = options;
    let appInstance: BunestApplication | undefined;
    let bootstrapPromise: Promise<BunestApplication> | undefined;
    let closingPromise: Promise<void> | undefined;

    const ensureBootstrapped = (): Promise<BunestApplication> => {
      if (appInstance) {
        return Promise.resolve(appInstance);
      }
      if (bootstrapPromise) {
        return bootstrapPromise;
      }

      let pending: Promise<BunestApplication> | null = null;
      pending = (async (): Promise<BunestApplication> => {
        let createdApp: BunestApplication | undefined;
        try {
          createdApp = await BunestFactory.create(rootModule, createOptions);
          if (configure) {
            await configure(createdApp);
          }
          await createdApp.init();
          appInstance = createdApp;
          return createdApp;
        } catch (err) {
          if (createdApp) {
            await createdApp.close().catch(() => {});
          }
          throw err;
        } finally {
          if (bootstrapPromise === pending) {
            bootstrapPromise = undefined;
          }
        }
      })();

      bootstrapPromise = pending;
      return pending;
    };

    const handler = (async (
      req: Request,
      server?: unknown,
    ): Promise<Response> => {
      const app = appInstance ?? (await ensureBootstrapped());
      if (server !== undefined) {
        return app
          .getHttpAdapter()
          .fetch(req, server as BunServerLike);
      }
      return app.fetch(req);
    }) as BunestFetchHandler;

    Object.defineProperties(handler, {
      ready: {
        enumerable: true,
        value: (): Promise<BunestApplication> => ensureBootstrapped(),
      },
      close: {
        enumerable: true,
        value: (signal?: string): Promise<void> => {
          if (closingPromise) {
            return closingPromise;
          }
          const runClose = (async (): Promise<void> => {
            const inFlight = bootstrapPromise;
            const target =
              appInstance ??
              (inFlight ? await inFlight.catch(() => undefined) : undefined);
            appInstance = undefined;
            bootstrapPromise = undefined;
            if (target) {
              await target.close(signal);
            }
          })();
          closingPromise = runClose.finally(() => {
            if (closingPromise === runClose) {
              closingPromise = undefined;
            }
          });
          return closingPromise;
        },
      },
      [Symbol.asyncDispose]: {
        value: (): Promise<void> => handler.close(),
      },
    });

    return handler;
  }
}
