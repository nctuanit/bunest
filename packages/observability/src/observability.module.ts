import {
  Module,
  type DynamicModule,
  type ModuleImport,
  type Provider,
} from "@bunest/common";
import {
  CountedAspectHandler,
  SpanAspectHandler,
  TimedAspectHandler,
} from "./decorators/observability.decorators";
import { DevtoolsModule } from "./devtools/devtools.module";
import type { DevtoolsModuleOptions } from "./devtools/devtools.service";
import {
  HealthModule,
  type HealthModuleOptions,
} from "./health/health.module";
import {
  OBSERVABILITY_LOGGER_OPTIONS,
  ObservabilityLogger,
  type ObservabilityLoggerOptions,
} from "./logging/observability-logger";
import {
  MetricsModule,
  type MetricsModuleOptions,
} from "./metrics/metrics.module";
import {
  TracingModule,
  type TracingModuleOptions,
} from "./tracing/tracing.middleware";

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
    const providers: Provider[] = [];
    const exportsList: NonNullable<DynamicModule["exports"]> = [];

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

    return {
      module: ObservabilityModule,
      global: options.global ?? true,
      imports,
      providers,
      exports: exportsList,
    };
  }
}
