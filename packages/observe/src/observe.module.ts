import { AsyncLocalStorage } from "node:async_hooks";
import {
  Inject,
  Logger,
  Module,
  Optional,
  type DynamicModule,
  type MiddlewareConsumer,
  type NestApplicationOptions,
  type NestModule,
  type OnApplicationShutdown,
  type OnModuleInit,
  type Provider,
  type Type,
} from "@bunest/common";
import { HttpAdapterHost } from "@bunest/core";
import { ObserveAgentSharedBuffer } from "./agent/observe-agent.buffer";
import { createInstanceDecorator } from "./instrument/create-instance-decorator.instrument";
import type {
  CreateObserveModuleOptions,
  ObserveModuleAsyncOptions,
  ObserveModuleOptionsWithDefaults,
  ObserveOptions,
  ObserveOptionsFactory,
} from "./interfaces/observe-types";
import { OBSERVE_OPTIONS, TRACE_CONTEXT_KEY } from "./observe.constants";
import { DEFAULT_SPAN_COLLAPSE } from "./services/collapse-repeated-spans.util";
import { OperationTraceRegistry } from "./services/operation-trace.registry";
import { collectRuntimeMetrics } from "./services/runtime-metrics.service";
import { resolveSkipSpans } from "./services/skip-spans.util";
import { TracerService } from "./services/tracer.service";
import type { KeyOf } from "./types/key-of.type";
import {
  defaultTraceIdGenerator,
  openTelemetryTraceIdGenerator,
} from "./utils/default-trace-id-generator.util";
import { LogRedactor } from "./utils/log-redactor";
import { readTraceContext } from "./utils/trace-context.util";

const OBSERVE_ALS_TOKEN = Symbol("OBSERVE_ALS");

function matchesHttpIgnore(
  ignore: NonNullable<ObserveOptions["http"]>["ignore"],
  req: Request,
): boolean {
  if (!ignore) return false;
  if (typeof ignore === "function") {
    try {
      return Boolean(ignore(req));
    } catch {
      return false;
    }
  }
  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;
  const method = req.method.toUpperCase();
  for (const rule of ignore) {
    if (typeof rule === "string" && pathname === rule) return true;
    if (rule instanceof RegExp && rule.test(pathname)) return true;
    if (typeof rule === "object" && !(rule instanceof RegExp)) {
      if (rule.method.toUpperCase() !== method) continue;
      if (typeof rule.path === "string" && pathname === rule.path) return true;
      if (rule.path instanceof RegExp && rule.path.test(pathname)) return true;
    }
  }
  return false;
}

function shouldSample(
  rate: ObserveOptions["tracesSampleRate"],
  protocol: "http" | "rpc" | "grpc" | "graphql" | "ws",
  attributes: Record<string, unknown>,
): boolean {
  if (rate === undefined || rate === 0) return true;
  if (typeof rate === "function") {
    try {
      return Boolean(rate(protocol, attributes));
    } catch {
      return true;
    }
  }
  if (rate >= 1) return true;
  if (rate < 0) return false;
  return Math.random() < rate;
}

export function createObserveModule<Store extends Record<string, unknown>>(
  options: CreateObserveModuleOptions = {},
): {
  ObserveInstrument: NestApplicationOptions["instrument"];
  ObserveModule: {
    new (
      httpAdapterHost: HttpAdapterHost,
      asyncLocalStorage: AsyncLocalStorage<Map<KeyOf<Store>, any>>,
      options: ObserveModuleOptionsWithDefaults,
    ): {
      readonly logger: Logger;
      readonly httpAdapterHost: HttpAdapterHost;
      readonly asyncLocalStorage: AsyncLocalStorage<Map<KeyOf<Store>, any>>;
      readonly options: ObserveModuleOptionsWithDefaults;
    };
    forRoot(observeOpts: ObserveOptions): DynamicModule;
    forRootAsync(options: ObserveModuleAsyncOptions): DynamicModule;
    createAsyncProviders(asyncOptions: ObserveModuleAsyncOptions): Provider[];
    createAsyncOptionsProvider(asyncOptions: ObserveModuleAsyncOptions): Provider;
  };
} {
  const traceIdKey = options.traceIdKey ?? "traceId";
  const customGenerator = options.traceIdGenerator;
  const attachTraceIdToLogs = options.attachTraceIdToLogs ?? true;
  const skipInstrumentation = options.skipInstrumentation ?? (() => false);
  const sourceContext = options.sourceContext ?? true;

  const als = new AsyncLocalStorage<Map<KeyOf<Store>, any>>();
  const registry = new OperationTraceRegistry(
    als as unknown as AsyncLocalStorage<Map<any, unknown>>,
    sourceContext,
  );
  const sharedBuffer = new ObserveAgentSharedBuffer();

  const instanceDecorator = createInstanceDecorator<Store>(als, registry, {
    traceIdKey,
    skipInstrumentation,
  });

  const ObserveInstrument: NestApplicationOptions["instrument"] = {
    instanceDecorator,
  };

  function mergeWithDefaults(
    observeOpts: ObserveOptions,
  ): ObserveModuleOptionsWithDefaults {
    const resolvedGenerator =
      customGenerator ??
      (observeOpts.openTelemetry
        ? openTelemetryTraceIdGenerator
        : defaultTraceIdGenerator);
    return {
      ...observeOpts,
      traceIdKey,
      traceIdGenerator: resolvedGenerator,
      attachTraceIdToLogs,
      skipInstrumentation,
      sourceContext,
    };
  }

  @Module({})
  class ObserveModule
    implements NestModule, OnModuleInit, OnApplicationShutdown
  {
    readonly logger = new Logger("ObserveModule");
    readonly httpAdapterHost: HttpAdapterHost;
    readonly asyncLocalStorage: AsyncLocalStorage<Map<KeyOf<Store>, any>>;
    readonly options: ObserveModuleOptionsWithDefaults;
    private runtimeTimer?: ReturnType<typeof setInterval>;
    private lastCpu?: NodeJS.CpuUsage;

    constructor(
      @Optional() httpAdapterHost: HttpAdapterHost,
      @Inject(OBSERVE_ALS_TOKEN)
      asyncLocalStorage: AsyncLocalStorage<Map<KeyOf<Store>, any>>,
      @Inject(OBSERVE_OPTIONS) options: ObserveModuleOptionsWithDefaults,
    ) {
      this.httpAdapterHost = httpAdapterHost ?? new HttpAdapterHost();
      this.asyncLocalStorage = asyncLocalStorage;
      this.options = options;
    }

    configure(consumer: MiddlewareConsumer): void {
      if (this.options.enabled === false) {
        return;
      }
      consumer
        .apply(async (req, res, next) => {
          if (matchesHttpIgnore(this.options.http?.ignore, req)) {
            return await next();
          }
          if (
            !this.options.http?.tracePreflights &&
            req.method.toUpperCase() === "OPTIONS" &&
            req.headers.get("access-control-request-method")
          ) {
            return await next();
          }

          const traceId = this.options.traceIdGenerator(req);
          const url = new URL(req.url, "http://localhost");
          const sampled = shouldSample(this.options.tracesSampleRate, "http", {
            method: req.method,
            url: url.pathname,
          });
          const store = new Map<KeyOf<Store>, any>();
          store.set(traceIdKey as KeyOf<Store>, traceId);

          const traceCtx = this.options.openTelemetry
            ? readTraceContext(req.headers)
            : undefined;
          if (traceCtx) {
            store.set(TRACE_CONTEXT_KEY as KeyOf<Store>, traceCtx);
          }

          if (this.options.http?.setAttributes) {
            try {
              const attrs = this.options.http.setAttributes(req);
              for (const [k, v] of Object.entries(attrs ?? {})) {
                if (k !== traceIdKey) {
                  store.set(k as KeyOf<Store>, v);
                }
              }
            } catch {
              // Ignore user callback failure
            }
          }

          if (sampled) {
            registry.startTrace(
              traceId,
              {
                protocol: url.protocol.replace(":", "") || "http",
                operationId: url.pathname,
                tags: this.options.http?.tags
                  ? { ...this.options.http.tags }
                  : undefined,
                attributes: {
                  method: req.method,
                  originalUrl: url.pathname + url.search,
                },
              },
              traceId,
              traceCtx,
            );
            registry.keepWithoutSpans(traceId);
          }

          return await this.asyncLocalStorage.run(store, async () => {
            try {
              const result = await next();
              if (sampled) {
                const statusCode =
                  result instanceof Response
                    ? result.status
                    : typeof res?.getStatus === "function"
                      ? (res.getStatus() ?? 200)
                      : 200;
                const userId = this.options.http?.getUserId?.(req);
                registry.endTrace(traceId, {
                  statusCode,
                  ...(userId ? { userId } : {}),
                });
                const snap = await registry.pluckSnapshot(traceId);
                if (snap) {
                  sharedBuffer.pushTrace(snap);
                }
              }
              return result;
            } catch (err) {
              if (sampled) {
                registry.captureError(
                  traceId,
                  undefined,
                  err instanceof Error ? err : String(err),
                  {},
                );
                registry.endTrace(traceId, { statusCode: 500 });
                const snap = await registry.pluckSnapshot(traceId);
                if (snap) {
                  sharedBuffer.pushTrace(snap);
                }
              }
              throw err;
            }
          });
        })
        .forRoutes("*");
    }

    onModuleInit(): void {
      if (this.options.enabled === false) {
        this.logger.log("Observe agent is disabled via options.");
        return;
      }

      if (this.options.spanCollapse === false) {
        registry.configureSpanCollapse(undefined);
      } else {
        registry.configureSpanCollapse({
          threshold:
            this.options.spanCollapse?.threshold ??
            DEFAULT_SPAN_COLLAPSE.threshold,
          keepSlowest:
            this.options.spanCollapse?.keepSlowest ??
            DEFAULT_SPAN_COLLAPSE.keepSlowest,
        });
      }

      registry.configureSkipSpans(resolveSkipSpans(this.options.skipSpans));

      if (this.options.redaction?.enabled === false) {
        registry.configureRedaction(null);
      } else {
        registry.configureRedaction(new LogRedactor(this.options.redaction));
      }

      sharedBuffer.configure(this.options);
      sharedBuffer.startPeriodicFlush();

      if (this.options.runtimeMetrics !== false) {
        const interval = this.options.runtimeMetricsInterval ?? 60_000;
        if (interval > 0) {
          this.lastCpu = process.cpuUsage();
          this.runtimeTimer = setInterval(() => {
            const { sample, cpu } = collectRuntimeMetrics(
              this.lastCpu,
              interval,
            );
            this.lastCpu = cpu;
            sharedBuffer.pushRuntimeMetrics(sample);
          }, interval);
          this.runtimeTimer.unref?.();
        }
      }
    }

    async onApplicationShutdown(): Promise<void> {
      if (this.runtimeTimer) {
        clearInterval(this.runtimeTimer);
        this.runtimeTimer = undefined;
      }
      sharedBuffer.stopPeriodicFlush();
      const timeout = this.options.shutdownFlushTimeout ?? 2000;
      if (timeout > 0) {
        await Promise.race([
          sharedBuffer.flush(),
          new Promise<void>((resolve) => setTimeout(resolve, timeout)),
        ]);
      }
    }

    static forRoot(observeOpts: ObserveOptions): DynamicModule {
      const merged = mergeWithDefaults(observeOpts);
      const providers: Provider[] = [
        { provide: OBSERVE_OPTIONS, useValue: merged },
        { provide: OBSERVE_ALS_TOKEN, useValue: als },
        { provide: OperationTraceRegistry, useValue: registry },
        { provide: ObserveAgentSharedBuffer, useValue: sharedBuffer },
        {
          provide: TracerService,
          useFactory: (opts: ObserveModuleOptionsWithDefaults) =>
            new TracerService(
              registry,
              als as unknown as AsyncLocalStorage<Map<string | symbol, any>>,
              sharedBuffer,
              opts,
            ),
          inject: [OBSERVE_OPTIONS],
        },
      ];
      return {
        module: ObserveModule,
        global: true,
        providers,
        exports: [
          OBSERVE_OPTIONS,
          TracerService,
          OperationTraceRegistry,
          ObserveAgentSharedBuffer,
        ],
      };
    }

    static forRootAsync(asyncOpts: ObserveModuleAsyncOptions): DynamicModule {
      const asyncProviders = ObserveModule.createAsyncProviders(asyncOpts);
      const providers: Provider[] = [
        ...asyncProviders,
        ...(asyncOpts.extraProviders ?? []),
        { provide: OBSERVE_ALS_TOKEN, useValue: als },
        { provide: OperationTraceRegistry, useValue: registry },
        { provide: ObserveAgentSharedBuffer, useValue: sharedBuffer },
        {
          provide: TracerService,
          useFactory: (opts: ObserveModuleOptionsWithDefaults) =>
            new TracerService(
              registry,
              als as unknown as AsyncLocalStorage<Map<string | symbol, any>>,
              sharedBuffer,
              opts,
            ),
          inject: [OBSERVE_OPTIONS],
        },
      ];
      return {
        module: ObserveModule,
        global: asyncOpts.global ?? true,
        imports: asyncOpts.imports ? [...asyncOpts.imports] : [],
        providers,
        exports: [
          OBSERVE_OPTIONS,
          TracerService,
          OperationTraceRegistry,
          ObserveAgentSharedBuffer,
        ],
      };
    }

    static createAsyncProviders(
      asyncOptions: ObserveModuleAsyncOptions,
    ): Provider[] {
      if (asyncOptions.useExisting || asyncOptions.useFactory) {
        return [ObserveModule.createAsyncOptionsProvider(asyncOptions)];
      }
      if (asyncOptions.useClass) {
        const useClass = asyncOptions.useClass as Type<ObserveOptionsFactory>;
        return [
          ObserveModule.createAsyncOptionsProvider(asyncOptions),
          {
            provide: useClass,
            useClass,
          },
        ];
      }
      throw new Error(
        "ObserveModule.forRootAsync() requires useFactory, useClass, or useExisting",
      );
    }

    static createAsyncOptionsProvider(
      asyncOptions: ObserveModuleAsyncOptions,
    ): Provider {
      if (asyncOptions.useFactory) {
        return {
          provide: OBSERVE_OPTIONS,
          useFactory: async (...args: any[]) =>
            mergeWithDefaults(await asyncOptions.useFactory!(...args)),
          inject: asyncOptions.inject ? [...asyncOptions.inject] : [],
        };
      }
      const injectToken = asyncOptions.useExisting ?? asyncOptions.useClass;
      if (!injectToken) {
        throw new Error(
          "ObserveModule.forRootAsync() requires useFactory, useClass, or useExisting",
        );
      }
      return {
        provide: OBSERVE_OPTIONS,
        useFactory: async (factory: ObserveOptionsFactory) =>
          mergeWithDefaults(await factory.createObserveOptions()),
        inject: [injectToken],
      };
    }
  }

  return {
    ObserveInstrument,
    ObserveModule,
  };
}
