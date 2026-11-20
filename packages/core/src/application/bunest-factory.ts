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
} from "@bunest/common";
import { BunHttpAdapter } from "@bunest/http";
import { DIContainer } from "../di/di-container";
import type {
  BunestApplicationContextOptions,
  ContainerOverrides,
  IEntryNestModule,
} from "../interfaces/core-types.interface";
import { ModuleScanner } from "../module/module-scanner";
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
> =
  | T
  | ((context: BunestApplicationContext) => T | Promise<T>);

/**
 * Standalone microservice application created via `BunestFactory.createMicroservice()`,
 * uniting DI/Modules/Lifecycle with any `MicroserviceInstance` transport server
 * (e.g. `TcpServer`, `GrpcServer`, `KafkaServer`, `MqttServer`, or `MicroserviceHost`).
 */
export class BunestMicroserviceApplication<
  T extends MicroserviceInstance = MicroserviceInstance,
> extends BunestApplicationContext {
  private started = false;

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

  async listen(): Promise<void> {
    await this.init();
    if (this.started) {
      return;
    }
    await this.microservice.listen();
    this.started = true;
  }

  protected override async stopTransport(): Promise<void> {
    if (!this.started) {
      return;
    }
    try {
      await this.microservice.close();
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
      const scanner = new ModuleScanner();
      const graph = await scanner.scan(rootModule, {
        moduleOverrides: options.overrides?.modules,
        moduleIdGeneratorAlgorithm: options.moduleIdGeneratorAlgorithm,
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
   * classes from `DecoratorRegistry` and returns a ready `BunestApplication`.
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
      ...createOptions
    } = options;

    @AutoModule({
      ...(imports !== undefined ? { imports } : {}),
      ...(controllers !== undefined ? { controllers } : {}),
      ...(providers !== undefined ? { providers } : {}),
      ...(moduleExports !== undefined ? { exports: moduleExports } : {}),
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
      const scanner = new ModuleScanner();
      const graph = await scanner.scan(rootModule, {
        moduleOverrides: options.overrides?.modules,
        moduleIdGeneratorAlgorithm: options.moduleIdGeneratorAlgorithm,
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
      const scanner = new ModuleScanner();
      const graph = await scanner.scan(rootModule, {
        moduleOverrides: options.overrides?.modules,
        moduleIdGeneratorAlgorithm: options.moduleIdGeneratorAlgorithm,
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
}
