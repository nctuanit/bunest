import {
  APP_INTERCEPTOR,
  Module,
  type BunestInterceptor,
  type DynamicModule,
  type FactoryDependency,
  type InjectionToken,
  type ModuleImport,
  type ModuleMetadata,
  type Provider,
  type Type,
} from "@bunest/core";
import {
  CountedAspectHandler,
  SpanAspectHandler,
  TimedAspectHandler,
} from "./decorators/observability.decorators";
import { DevtoolsModule } from "./devtools/devtools.module";
import type { DevtoolsModuleOptions } from "./devtools/devtools.service";
import { HealthModule, type HealthModuleOptions } from "./health/health.module";
import {
  OBSERVABILITY_LOGGER_OPTIONS,
  ObservabilityLogger,
  type ObservabilityLoggerOptions,
} from "./logging/observability-logger";
import {
  HttpMetricsInterceptor,
  METRICS_MODULE_OPTIONS,
  MetricsModule,
  type MetricsModuleOptions,
} from "./metrics/metrics.module";
import { MetricsRegistry } from "./metrics/metrics.registry";
import { OtlpHttpMetricsExporter } from "./metrics/otlp-metrics-exporter";
import {
  AUTO_INSTRUMENT_OPTIONS,
  OtelAutoInstrumentation,
  type AutoInstrumentOptions,
} from "./tracing/auto-instrumentation";
import { TRACER_OPTIONS, Tracer } from "./tracing/tracer";
import {
  TracingInterceptor,
  TracingMiddleware,
  TracingModule,
  type TracingModuleOptions,
} from "./tracing/tracing.middleware";

export const OBSERVABILITY_MODULE_OPTIONS = Symbol.for(
  "bunest:observability:module_options",
);

export interface ObservabilityModuleOptions {
  /**
   * Registers `ObservabilityModule` globally across the application.
   * @default true
   */
  global?: boolean;
  /**
   * Tracing configuration (`false` disables `TracingModule`).
   */
  tracing?: TracingModuleOptions | boolean;
  /**
   * Metrics configuration (`false` disables `MetricsModule`).
   */
  metrics?: MetricsModuleOptions | boolean;
  /**
   * Structured correlated logger configuration (`false` disables `ObservabilityLogger`).
   */
  logging?: ObservabilityLoggerOptions | boolean;
  /**
   * Optional health check endpoints & indicators (`HealthModule.forRoot`).
   */
  health?: HealthModuleOptions | boolean;
  /**
   * Optional devtools graph introspection (`DevtoolsModule.register`).
   */
  devtools?: DevtoolsModuleOptions | boolean;
  /**
   * Enables zero-config cross-subsystem OTel auto-instrumentation via
   * `diagnosticsChannel` (ORM, Jobs, Microservices RPC, HttpClient) and
   * registers `@bunest/core`'s ambient W3C `traceparent` provider.
   */
  autoInstrument?: boolean | AutoInstrumentOptions;
}

export interface ObservabilityOptionsFactory {
  createObservabilityOptions():
    | Promise<ObservabilityModuleOptions>
    | ObservabilityModuleOptions;
}

export interface ObservabilityModuleAsyncOptions {
  /**
   * Registers `ObservabilityModule` globally across the application.
   * @default true
   */
  global?: boolean;
  imports?: ModuleMetadata["imports"];
  inject?: FactoryDependency[];
  useFactory?: (
    ...args: any[]
  ) => Promise<ObservabilityModuleOptions> | ObservabilityModuleOptions;
  useClass?: Type<ObservabilityOptionsFactory>;
  useExisting?: InjectionToken<ObservabilityOptionsFactory>;
  extraProviders?: Provider[];
  /**
   * Registers `TracingInterceptor` as an `APP_INTERCEPTOR` (also honored when
   * `tracing.registerGlobalInterceptor` is returned asynchronously from the factory).
   */
  registerGlobalTracingInterceptor?: boolean;
  /**
   * Registers `HttpMetricsInterceptor` as an `APP_INTERCEPTOR` (also honored when
   * `metrics.registerGlobalInterceptor` is returned asynchronously from the factory).
   */
  registerGlobalMetricsInterceptor?: boolean;
  /**
   * Optional health check endpoints & indicators (`HealthModule.forRoot`).
   */
  health?: HealthModuleOptions | boolean;
  /**
   * Optional devtools graph introspection (`DevtoolsModule.register`).
   */
  devtools?: DevtoolsModuleOptions | boolean;
  /**
   * Enables zero-config cross-subsystem OTel auto-instrumentation via
   * `diagnosticsChannel` (ORM, Jobs, Microservices RPC, HttpClient) and
   * registers `@bunest/core`'s ambient W3C `traceparent` provider.
   */
  autoInstrument?: boolean | AutoInstrumentOptions;
}

const NOOP_INTERCEPTOR: BunestInterceptor = {
  intercept(_context, next) {
    return next.handle();
  },
};

function createAsyncOptionsProviders(
  options: ObservabilityModuleAsyncOptions,
): Provider[] {
  if (options.useFactory) {
    return [
      {
        provide: OBSERVABILITY_MODULE_OPTIONS,
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
        provide: OBSERVABILITY_MODULE_OPTIONS,
        useFactory: async (factory: ObservabilityOptionsFactory) =>
          (await factory.createObservabilityOptions()) ?? {},
        inject: [factoryClass],
      },
    ];
  }

  if (options.useExisting) {
    return [
      {
        provide: OBSERVABILITY_MODULE_OPTIONS,
        useFactory: async (factory: ObservabilityOptionsFactory) =>
          (await factory.createObservabilityOptions()) ?? {},
        inject: [options.useExisting],
      },
    ];
  }

  throw new Error(
    'ObservabilityModule.forRootAsync() requires one of "useFactory", "useClass", or "useExisting".',
  );
}

/**
 * Unified observability module wiring distributed tracing (`@Span`/`@Trace`),
 * Prometheus metrics (`@Timed`/`@Counted`), correlated logging, and optional
 * health/devtools modules in a single import.
 */
@Module({})
export class ObservabilityModule {
  static forRoot(options: ObservabilityModuleOptions = {}): DynamicModule {
    const imports: ModuleImport[] = [];
    const providers: Provider[] = [
      { provide: OBSERVABILITY_MODULE_OPTIONS, useValue: options },
    ];
    const exportsList: Array<NonNullable<DynamicModule["exports"]>[number]> = [
      OBSERVABILITY_MODULE_OPTIONS,
    ];

    if (options.tracing !== false) {
      const tracingMod = TracingModule.forRoot(
        typeof options.tracing === "object" ? options.tracing : {},
      );
      imports.push(tracingMod);
      exportsList.push(tracingMod);
    } else {
      providers.push(SpanAspectHandler);
      exportsList.push(SpanAspectHandler);
    }

    if (options.metrics !== false) {
      const metricsOpts: MetricsModuleOptions =
        typeof options.metrics === "object"
          ? options.metrics
          : { exposeEndpoint: false };
      const metricsMod = MetricsModule.forRoot(metricsOpts);
      imports.push(metricsMod);
      exportsList.push(metricsMod);
    } else {
      providers.push(TimedAspectHandler, CountedAspectHandler);
      exportsList.push(TimedAspectHandler, CountedAspectHandler);
    }

    if (options.logging !== false) {
      const loggingOpts: ObservabilityLoggerOptions =
        typeof options.logging === "object" ? options.logging : {};
      providers.push(
        { provide: OBSERVABILITY_LOGGER_OPTIONS, useValue: loggingOpts },
        ObservabilityLogger,
      );
      exportsList.push(OBSERVABILITY_LOGGER_OPTIONS, ObservabilityLogger);
    }

    if (options.health) {
      const healthMod = HealthModule.forRoot(
        typeof options.health === "object" ? options.health : {},
      );
      imports.push(healthMod);
      exportsList.push(healthMod);
    }

    if (options.devtools) {
      const devtoolsMod = DevtoolsModule.register(
        typeof options.devtools === "object" ? options.devtools : {},
      );
      imports.push(devtoolsMod);
      exportsList.push(devtoolsMod);
    }

    if (options.autoInstrument && options.tracing !== false) {
      const autoOpts: AutoInstrumentOptions =
        typeof options.autoInstrument === "object"
          ? { enabled: true, ...options.autoInstrument }
          : { enabled: true };
      providers.push(
        { provide: AUTO_INSTRUMENT_OPTIONS, useValue: autoOpts },
        OtelAutoInstrumentation,
      );
      exportsList.push(AUTO_INSTRUMENT_OPTIONS, OtelAutoInstrumentation);
    }

    return {
      module: ObservabilityModule,
      global: options.global ?? true,
      imports,
      providers,
      exports: exportsList,
    };
  }

  /**
   * Registers `ObservabilityModule` asynchronously (via `useFactory`, `useClass`,
   * or `useExisting`), wiring `Tracer`, `TracingInterceptor`, `MetricsRegistry`,
   * `HttpMetricsInterceptor`, `ObservabilityLogger`, and aspect handlers from
   * DI-resolved configuration.
   */
  static forRootAsync(options: ObservabilityModuleAsyncOptions): DynamicModule {
    const asyncProviders = createAsyncOptionsProviders(options);
    const imports: ModuleImport[] = [...(options.imports ?? [])];
    const exportsList: Array<NonNullable<DynamicModule["exports"]>[number]> = [
      OBSERVABILITY_MODULE_OPTIONS,
      TRACER_OPTIONS,
      Tracer,
      TracingMiddleware,
      TracingInterceptor,
      SpanAspectHandler,
      METRICS_MODULE_OPTIONS,
      MetricsRegistry,
      HttpMetricsInterceptor,
      TimedAspectHandler,
      CountedAspectHandler,
      OBSERVABILITY_LOGGER_OPTIONS,
      ObservabilityLogger,
      AUTO_INSTRUMENT_OPTIONS,
      OtelAutoInstrumentation,
      OtlpHttpMetricsExporter,
    ];

    const providers: Provider[] = [
      ...asyncProviders,
      ...(options.extraProviders ?? []),
      {
        provide: TRACER_OPTIONS,
        useFactory: (resolved: ObservabilityModuleOptions): TracingModuleOptions =>
          resolved.tracing === false
            ? { sampler: () => false }
            : typeof resolved.tracing === "object"
              ? resolved.tracing
              : {},
        inject: [OBSERVABILITY_MODULE_OPTIONS],
      },
      Tracer,
      TracingMiddleware,
      TracingInterceptor,
      SpanAspectHandler,
      {
        provide: METRICS_MODULE_OPTIONS,
        useFactory: (resolved: ObservabilityModuleOptions): MetricsModuleOptions =>
          typeof resolved.metrics === "object"
            ? resolved.metrics
            : { exposeEndpoint: false },
        inject: [OBSERVABILITY_MODULE_OPTIONS],
      },
      {
        provide: MetricsRegistry,
        useFactory: (metricsOpts: MetricsModuleOptions) =>
          metricsOpts.registry ?? new MetricsRegistry(),
        inject: [METRICS_MODULE_OPTIONS],
      },
      HttpMetricsInterceptor,
      TimedAspectHandler,
      CountedAspectHandler,
      {
        provide: OBSERVABILITY_LOGGER_OPTIONS,
        useFactory: (
          resolved: ObservabilityModuleOptions,
        ): ObservabilityLoggerOptions =>
          typeof resolved.logging === "object" ? resolved.logging : {},
        inject: [OBSERVABILITY_MODULE_OPTIONS],
      },
      ObservabilityLogger,
      {
        provide: AUTO_INSTRUMENT_OPTIONS,
        useFactory: (
          resolved: ObservabilityModuleOptions,
        ): AutoInstrumentOptions => {
          if (resolved.tracing === false) {
            return { enabled: false };
          }
          const raw =
            resolved.autoInstrument !== undefined
              ? resolved.autoInstrument
              : options.autoInstrument;
          if (!raw) {
            return { enabled: false };
          }
          return typeof raw === "object"
            ? { enabled: true, ...raw }
            : { enabled: true };
        },
        inject: [OBSERVABILITY_MODULE_OPTIONS],
      },
      OtelAutoInstrumentation,
      {
        provide: OtlpHttpMetricsExporter,
        useFactory: (
          metricsOpts: MetricsModuleOptions,
          registry: MetricsRegistry,
        ): OtlpHttpMetricsExporter | undefined => {
          if (!metricsOpts.otlpExporter) {
            return undefined;
          }
          if (metricsOpts.otlpExporter instanceof OtlpHttpMetricsExporter) {
            return metricsOpts.otlpExporter.attachRegistry(registry);
          }
          return new OtlpHttpMetricsExporter(registry, metricsOpts.otlpExporter);
        },
        inject: [METRICS_MODULE_OPTIONS, MetricsRegistry],
      },
    ];

    if (options.registerGlobalTracingInterceptor !== false) {
      providers.push({
        provide: APP_INTERCEPTOR,
        useFactory: (
          resolved: ObservabilityModuleOptions,
          interceptor: TracingInterceptor,
        ): BunestInterceptor => {
          if (resolved.tracing === false) {
            return NOOP_INTERCEPTOR;
          }
          const enabled =
            options.registerGlobalTracingInterceptor === true ||
            (typeof resolved.tracing === "object" &&
              resolved.tracing.registerGlobalInterceptor === true);
          return enabled ? interceptor : NOOP_INTERCEPTOR;
        },
        inject: [OBSERVABILITY_MODULE_OPTIONS, TracingInterceptor],
      });
    }

    if (options.registerGlobalMetricsInterceptor !== false) {
      providers.push({
        provide: APP_INTERCEPTOR,
        useFactory: (
          resolved: ObservabilityModuleOptions,
          interceptor: HttpMetricsInterceptor,
        ): BunestInterceptor => {
          if (resolved.metrics === false) {
            return NOOP_INTERCEPTOR;
          }
          const enabled =
            options.registerGlobalMetricsInterceptor === true ||
            (typeof resolved.metrics === "object" &&
              resolved.metrics.registerGlobalInterceptor === true);
          return enabled ? interceptor : NOOP_INTERCEPTOR;
        },
        inject: [OBSERVABILITY_MODULE_OPTIONS, HttpMetricsInterceptor],
      });
    }

    if (options.health) {
      const healthMod = HealthModule.forRoot(
        typeof options.health === "object" ? options.health : {},
      );
      imports.push(healthMod);
      exportsList.push(healthMod);
    }

    if (options.devtools) {
      const devtoolsMod = DevtoolsModule.register(
        typeof options.devtools === "object" ? options.devtools : {},
      );
      imports.push(devtoolsMod);
      exportsList.push(devtoolsMod);
    }

    return {
      module: ObservabilityModule,
      global: options.global ?? true,
      imports,
      providers,
      exports: exportsList,
    };
  }
}
