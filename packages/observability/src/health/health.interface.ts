import type {
  FactoryDependency,
  InjectionToken,
  LoggerService,
  ModuleMetadata,
  Provider,
  Type,
} from "@bunest/core";

export const HEALTH_MODULE_OPTIONS = Symbol.for(
  "bunest:observability:health_options",
);

export const TERMINUS_MODULE_OPTIONS = Symbol.for(
  "bunest:observability:terminus_options",
);

export const TERMINUS_LOGGER = Symbol.for(
  "bunest:observability:terminus_logger",
);

export const CHECK_DISK_SPACE_LIB = Symbol.for(
  "bunest:observability:check_disk_space_lib",
);

/**
 * The statuses a health indicator can have.
 */
export const HealthIndicatorStatus = {
  UP: "up",
  DEGRADED: "degraded",
  DOWN: "down",
} as const;

export type HealthIndicatorStatus =
  (typeof HealthIndicatorStatus)[keyof typeof HealthIndicatorStatus];

export namespace HealthIndicatorStatus {
  export type UP = typeof HealthIndicatorStatus.UP;
  export type DEGRADED = typeof HealthIndicatorStatus.DEGRADED;
  export type DOWN = typeof HealthIndicatorStatus.DOWN;
}

/**
 * The overall statuses a health check can have.
 */
export const HealthCheckStatus = {
  ERROR: "error",
  OK: "ok",
  DEGRADED: "degraded",
  SHUTTING_DOWN: "shutting_down",
} as const;

export type HealthCheckStatus =
  (typeof HealthCheckStatus)[keyof typeof HealthCheckStatus];

export namespace HealthCheckStatus {
  export type ERROR = typeof HealthCheckStatus.ERROR;
  export type OK = typeof HealthCheckStatus.OK;
  export type DEGRADED = typeof HealthCheckStatus.DEGRADED;
  export type SHUTTING_DOWN = typeof HealthCheckStatus.SHUTTING_DOWN;
}

export interface HealthIndicatorDetail {
  readonly status: HealthIndicatorStatus;
  readonly message?: string;
  readonly [key: string]: unknown;
}

/**
 * The result object of a health indicator.
 */
export type HealthIndicatorResult<
  TKey extends string = string,
  TStatus extends HealthIndicatorStatus = HealthIndicatorStatus,
  TData extends Record<string, unknown> = Record<string, unknown>,
> = Record<
  TKey,
  {
    status: TStatus;
  } & TData
>;

/**
 * Base health indicator class providing `getStatus()` helper (compatible with
 * NestJS Terminus custom indicator subclasses and Bunest indicators).
 */
export abstract class HealthIndicator {
  protected getStatus(
    key: string,
    isHealthy: boolean,
    data?: Record<string, unknown>,
  ): HealthIndicatorResult {
    return {
      [key]: {
        status: isHealthy
          ? HealthIndicatorStatus.UP
          : HealthIndicatorStatus.DOWN,
        ...data,
      },
    };
  }
}

/**
 * The result of a health check execution.
 */
export type HealthCheckResult<
  TDetails extends HealthIndicatorResult = HealthIndicatorResult,
  TInfo extends Partial<HealthIndicatorResult> | undefined =
    Partial<TDetails> | undefined,
  TError extends Partial<HealthIndicatorResult> | undefined =
    Partial<TDetails> | undefined,
> = {
  /**
   * The overall status of the Health Check.
   */
  status: HealthCheckStatus;
  /**
   * Information of each health indicator with status `"up"` or `"degraded"`.
   */
  info?: TInfo;
  /**
   * Information of each health indicator with status `"down"`.
   */
  error?: TError;
  /**
   * Information of every health indicator.
   */
  details: TDetails;
  /**
   * ISO-8601 timestamp recorded when the health check completed.
   */
  readonly timestamp?: string;
};

/**
 * Options for both `@HealthCheck()` decorator and `HealthCheckService.check()`.
 */
export interface HealthCheckOptions {
  /** Per-indicator timeout in milliseconds (default: 5000ms) */
  timeoutMs?: number;
  /**
   * Whether to set `Cache-Control: no-cache, no-store, must-revalidate` on `@HealthCheck()` endpoints.
   * @default true
   */
  noCache?: boolean;
  /**
   * Whether to document `@HealthCheck()` endpoints with Swagger metadata if available.
   * @default true
   */
  swaggerDocumentation?: boolean;
}

export type ErrorLogStyle = "pretty" | "json";

/**
 * Options for synchronous `TerminusModule.forRoot()` registration.
 */
export interface TerminusModuleOptions {
  /**
   * The style of the error logger.
   * @default 'json'
   */
  errorLogStyle?: ErrorLogStyle;
  /**
   * The logger to use: `true` for default logger, `false` to disable, or a custom `LoggerService` class.
   */
  logger?: Type<LoggerService> | boolean;
  /**
   * Milliseconds to wait before completing application shutdown while returning `shutting_down`.
   * @default 0
   */
  gracefulShutdownTimeoutMs?: number;
}

/**
 * Options for asynchronous `TerminusModule.forRootAsync()` registration.
 */
export type TerminusAsyncModuleOptions = Omit<
  TerminusModuleOptions,
  "logger"
> & {
  /**
   * A resolved logger instance, or a boolean (`false` disables logging, `true` uses default logger).
   */
  logger?: LoggerService | boolean;
};

/**
 * Factory interface for `TerminusModule.forRootAsync({ useClass | useExisting })`.
 */
export interface TerminusOptionsFactory {
  createTerminusOptions():
    Promise<TerminusAsyncModuleOptions> | TerminusAsyncModuleOptions;
}

/**
 * Asynchronous configuration options for `TerminusModule.forRootAsync()`.
 */
export interface TerminusAsyncOptions extends Pick<ModuleMetadata, "imports"> {
  useExisting?:
    Type<TerminusOptionsFactory> | InjectionToken<TerminusOptionsFactory>;
  useClass?: Type<TerminusOptionsFactory>;
  useFactory?: (
    ...args: any[]
  ) => Promise<TerminusAsyncModuleOptions> | TerminusAsyncModuleOptions;
  inject?: FactoryDependency[];
  extraProviders?: Provider[];
  global?: boolean;
}
