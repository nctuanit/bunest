import {
  Controller,
  Get,
  Inject,
  Logger,
  Module,
  type DynamicModule,
  type LoggerService,
  type Provider,
  type Type,
} from "@bunest/common";
import {
  HealthIndicatorService,
  type HealthIndicatorFunction,
} from "./health-indicator.service";
import {
  DiskHealthIndicator,
  EventLoopHealthIndicator,
  FetchHealthIndicator,
  GRPCHealthIndicator,
  HttpHealthIndicator,
  MemoryHealthIndicator,
  MicroserviceHealthIndicator,
  PrismaHealthIndicator,
  defaultCheckDiskSpace,
} from "./health.indicators";
import {
  CHECK_DISK_SPACE_LIB,
  HEALTH_MODULE_OPTIONS,
  TERMINUS_LOGGER,
  TERMINUS_MODULE_OPTIONS,
  type HealthCheckResult,
  type TerminusAsyncModuleOptions,
  type TerminusAsyncOptions,
  type TerminusModuleOptions,
  type TerminusOptionsFactory,
} from "./health.interface";
import { HealthCheckException, HealthCheckService } from "./health.service";

export interface HealthModuleOptions extends TerminusModuleOptions {
  livenessPath?: string;
  readinessPath?: string;
  livenessIndicators?: readonly HealthIndicatorFunction[];
  readinessIndicators?: readonly HealthIndicatorFunction[];
  timeoutMs?: number;
  exposeEndpoints?: boolean;
  global?: boolean;
}

const NOOP_LOGGER: LoggerService = {
  log() {},
  error() {},
  warn() {},
  debug() {},
  verbose() {},
};

function resolveLoggerFromSyncOptions(
  options: TerminusModuleOptions,
): Provider {
  if (options.logger === false) {
    return { provide: TERMINUS_LOGGER, useValue: NOOP_LOGGER };
  }
  if (typeof options.logger === "function") {
    return { provide: TERMINUS_LOGGER, useClass: options.logger };
  }
  return {
    provide: TERMINUS_LOGGER,
    useValue: new Logger("HealthCheckService"),
  };
}

function resolveLoggerFromAsyncOptions(
  options: TerminusAsyncModuleOptions,
): LoggerService {
  if (options.logger === false) {
    return NOOP_LOGGER;
  }
  if (options.logger && typeof options.logger === "object") {
    return options.logger;
  }
  return new Logger("HealthCheckService");
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed === "/") return "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function createHealthController(
  livenessPath: string,
  readinessPath: string,
): Type<unknown> {
  @Controller()
  class HealthController {
    constructor(
      @Inject(HealthCheckService)
      private readonly health: HealthCheckService,
      @Inject(HEALTH_MODULE_OPTIONS)
      private readonly options: HealthModuleOptions,
    ) {}

    @Get(normalizePath(livenessPath))
    async liveness(): Promise<Response> {
      const indicators = this.options.livenessIndicators ?? [
        () => ({ app: { status: "up" } }),
      ];
      return this.executeCheck(indicators);
    }

    @Get(normalizePath(readinessPath))
    async readiness(): Promise<Response> {
      const indicators = this.options.readinessIndicators ?? [
        () => ({ app: { status: "up" } }),
      ];
      return this.executeCheck(indicators);
    }

    private async executeCheck(
      indicators: readonly HealthIndicatorFunction[],
    ): Promise<Response> {
      try {
        const result: HealthCheckResult = await this.health.check(indicators, {
          timeoutMs: this.options.timeoutMs,
        });
        return Response.json(result, { status: 200 });
      } catch (err) {
        if (err instanceof HealthCheckException) {
          return Response.json(err.result, { status: 503 });
        }
        throw err;
      }
    }
  }

  return HealthController;
}

const TERMINUS_BASE_INDICATORS = [
  MemoryHealthIndicator,
  EventLoopHealthIndicator,
  FetchHealthIndicator,
  HttpHealthIndicator,
  DiskHealthIndicator,
  PrismaHealthIndicator,
  MicroserviceHealthIndicator,
  GRPCHealthIndicator,
] as const;

const TERMINUS_EXPORTS = [
  HealthCheckService,
  HealthIndicatorService,
  ...TERMINUS_BASE_INDICATORS,
];

function createTerminusAsyncOptionProviders(
  options: TerminusAsyncOptions,
): Provider[] {
  if (options.useFactory) {
    return [
      {
        provide: TERMINUS_MODULE_OPTIONS,
        useFactory: async (...args: unknown[]) =>
          (await options.useFactory!(...args)) ?? {},
        inject: options.inject ?? [],
      },
    ];
  }

  if (options.useClass) {
    const factoryClass = options.useClass;
    return [
      { provide: factoryClass, useClass: factoryClass },
      {
        provide: TERMINUS_MODULE_OPTIONS,
        useFactory: async (factory: TerminusOptionsFactory) =>
          (await factory.createTerminusOptions()) ?? {},
        inject: [factoryClass],
      },
    ];
  }

  if (options.useExisting) {
    return [
      {
        provide: TERMINUS_MODULE_OPTIONS,
        useFactory: async (factory: TerminusOptionsFactory) =>
          (await factory.createTerminusOptions()) ?? {},
        inject: [options.useExisting],
      },
    ];
  }

  throw new Error(
    'TerminusModule.forRootAsync() requires one of "useFactory", "useClass", or "useExisting".',
  );
}

/**
 * NestJS Terminus v12-compatible health check module providing `HealthCheckService`,
 * `HealthIndicatorService`, and all built-in zero-dep indicators.
 */
@Module({
  providers: [
    HealthIndicatorService,
    HealthCheckService,
    ...TERMINUS_BASE_INDICATORS,
  ],
  exports: [...TERMINUS_EXPORTS],
})
export class TerminusModule {
  /**
   * Register the Terminus module synchronously.
   */
  static forRoot(options: TerminusModuleOptions = {}): DynamicModule {
    return {
      module: TerminusModule,
      providers: [
        { provide: TERMINUS_MODULE_OPTIONS, useValue: options },
        resolveLoggerFromSyncOptions(options),
        { provide: CHECK_DISK_SPACE_LIB, useValue: defaultCheckDiskSpace },
      ],
      exports: [...TERMINUS_EXPORTS],
    };
  }

  /**
   * Register the Terminus module asynchronously.
   */
  static forRootAsync(options: TerminusAsyncOptions): DynamicModule {
    const asyncProviders = createTerminusAsyncOptionProviders(options);
    return {
      module: TerminusModule,
      global: options.global,
      imports: options.imports ?? [],
      providers: [
        ...asyncProviders,
        ...(options.extraProviders ?? []),
        {
          provide: TERMINUS_LOGGER,
          useFactory: (resolved: TerminusAsyncModuleOptions) =>
            resolveLoggerFromAsyncOptions(resolved),
          inject: [TERMINUS_MODULE_OPTIONS],
        },
        { provide: CHECK_DISK_SPACE_LIB, useValue: defaultCheckDiskSpace },
      ],
      exports: [...TERMINUS_EXPORTS],
    };
  }
}

/**
 * Bunest batteries-included health module adding optional automatic `/health` & `/ready` endpoints
 * on top of `TerminusModule` services and indicators.
 */
@Module({})
export class HealthModule {
  static forRoot(options: HealthModuleOptions = {}): DynamicModule {
    const exposeEndpoints = options.exposeEndpoints ?? true;
    const livenessPath = options.livenessPath ?? "/health";
    const readinessPath = options.readinessPath ?? "/ready";

    const controllers: Type<unknown>[] = exposeEndpoints
      ? [createHealthController(livenessPath, readinessPath)]
      : [];

    return {
      module: HealthModule,
      global: options.global,
      controllers,
      providers: [
        { provide: HEALTH_MODULE_OPTIONS, useValue: options },
        { provide: TERMINUS_MODULE_OPTIONS, useValue: options },
        resolveLoggerFromSyncOptions(options),
        { provide: CHECK_DISK_SPACE_LIB, useValue: defaultCheckDiskSpace },
        HealthIndicatorService,
        HealthCheckService,
        ...TERMINUS_BASE_INDICATORS,
      ],
      exports: [
        HEALTH_MODULE_OPTIONS,
        ...TERMINUS_EXPORTS,
      ],
    };
  }

  static forRootAsync(options: TerminusAsyncOptions): DynamicModule {
    const asyncProviders = createTerminusAsyncOptionProviders(options);
    return {
      module: HealthModule,
      global: options.global,
      imports: options.imports ?? [],
      providers: [
        ...asyncProviders,
        ...(options.extraProviders ?? []),
        {
          provide: HEALTH_MODULE_OPTIONS,
          useExisting: TERMINUS_MODULE_OPTIONS,
        },
        {
          provide: TERMINUS_LOGGER,
          useFactory: (resolved: TerminusAsyncModuleOptions) =>
            resolveLoggerFromAsyncOptions(resolved),
          inject: [TERMINUS_MODULE_OPTIONS],
        },
        { provide: CHECK_DISK_SPACE_LIB, useValue: defaultCheckDiskSpace },
        HealthIndicatorService,
        HealthCheckService,
        ...TERMINUS_BASE_INDICATORS,
      ],
      exports: [
        HEALTH_MODULE_OPTIONS,
        ...TERMINUS_EXPORTS,
      ],
    };
  }
}
