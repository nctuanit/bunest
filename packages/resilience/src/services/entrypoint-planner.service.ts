import {
  Injectable,
  METADATA_KEYS,
  MetadataRegistry,
  type ExecutionContext,
  type Type,
} from "@bunest/core";
import { ModuleRef } from "@bunest/core";
import { OptionError } from "../errors/option.error";
import type { BulkheadOptions } from "../interfaces/bulkhead-options.interface";
import type { CircuitBreakerOptions } from "../interfaces/circuit-breaker-options.interface";
import type { Duration } from "../interfaces/duration.interface";
import type {
  EntrypointRetryOptions,
  FallbackMetadata,
} from "../interfaces/entrypoint-options.interface";
import type { ResiliencePreset } from "../interfaces/resilience-module-options.interface";
import type { ResiliencePolicy } from "../policies/resilience.policy";
import { normalizeRetry } from "../policies/retry.policy";
import {
  BULKHEAD_METADATA,
  CIRCUIT_BREAKER_METADATA,
  FALLBACK_METADATA,
  PRESET_METADATA,
  RESILIENCE_METADATA_KEYS,
  RETRY_METADATA,
  TIMEOUT_METADATA,
} from "../resilience.constants";
import {
  definedFields,
  mergeRetry,
  PolicyFactory,
} from "./policy-factory.service";

// Metadata keys of other packages, read without importing them.
const GRAPHQL_RESOLVER_TYPE = "graphql:resolver_type";
const GRAPHQL_FIELD_RESOLVER = "graphql:resolve_property";
const MICROSERVICES_PATTERN = "microservices:pattern";
const NEST_SSE_METADATA = "__sse__";
const NEST_METHOD_METADATA = "method";
const NEST_ROUTE_ARGS_METADATA = "__routeArguments__";
const NEST_RESPONSE_PASSTHROUGH_METADATA = "__responsePassthrough__";

const STAGE_METADATA: Partial<Record<string, string>> = {
  fallback: FALLBACK_METADATA,
  retry: RETRY_METADATA,
  circuitBreaker: CIRCUIT_BREAKER_METADATA,
  timeout: TIMEOUT_METADATA,
  bulkhead: BULKHEAD_METADATA,
};

export interface EntrypointPlan {
  /** `OrdersController.list` */
  source: string;
  /** Full pipeline, used when repeating the handler is safe. */
  withRetry: ResiliencePolicy;
  /** Same stages (and state) without Retry. */
  withoutRetry: ResiliencePolicy;
  hasRetry: boolean;
  idempotent: boolean;
  /**
   * A `@Retry()` decorator sits on the handler itself (not only inherited from
   * the class or a preset).
   */
  retryOnMethod: boolean;
  /**
   * The handler consumes a request stream (a gRPC client or bidirectional
   * stream), which a second attempt can't read again: never retried.
   */
  requestStream: boolean;
  /**
   * An `@Sse()` route.
   */
  sse: boolean;
}

export interface Entrypoint {
  cls: Type;
  handler: Function;
  /** Whether the class has one instance (entrypoint method-name fallbacks need it). */
  isStatic: boolean;
  /** True when planned for an `@Injectable()` service method woven via Core Method Aspects. */
  isService?: boolean;
}

interface ResolvedEntrypoint {
  source: string;
  spec: ResiliencePreset;
  fallbackMethod?: string;
  retryOnMethod: boolean;
  idempotent: boolean;
  requestStream: boolean;
  sse: boolean;
  perHandler: Array<"circuitBreaker" | "bulkhead">;
  warnings: string[];
}

interface StageMatch<T = unknown> {
  value: T;
  preset: boolean;
  level: Function;
}

/**
 * Turns decorator metadata into policy pipelines, one per handler, cached for
 * the app's lifetime.
 */
@Injectable()
export class EntrypointPlanner {
  private readonly plans = new Map<
    Type,
    Map<Function, EntrypointPlan | null>
  >();
  private readonly instances = new Map<Type, Record<string, unknown>>();

  constructor(
    private readonly factory: PolicyFactory,
    private readonly moduleRef: ModuleRef,
  ) {}

  planFor(cls: Type, handler: Function): EntrypointPlan | null {
    let byHandler = this.plans.get(cls);
    if (!byHandler) {
      byHandler = new Map();
      this.plans.set(cls, byHandler);
    }
    if (!byHandler.has(handler)) {
      const resolved = this.resolve(cls, handler);
      const hasStages = !!resolved && Object.keys(resolved.spec).length > 0;
      if (hasStages) {
        this.factory.declare(resolved.spec, resolved.source);
      }
      byHandler.set(handler, hasStages ? this.build(resolved) : null);
    }
    return byHandler.get(handler) ?? null;
  }

  /**
   * Bootstrap: resolves every entrypoint, declares all named instances (the
   * presets' first) before any is created, so conflicting configurations fail
   * regardless of order, then builds and caches the plans.
   */
  prepare(entrypoints: Entrypoint[]): {
    planned: Array<Entrypoint & { plan: EntrypointPlan }>;
    warnings: string[];
  } {
    this.factory.declarePresets();
    const warnings: string[] = [];
    const resolved: Array<{ entry: Entrypoint; r: ResolvedEntrypoint }> = [];

    for (const entry of entrypoints) {
      const r = this.resolve(entry.cls, entry.handler);
      if (r) {
        warnings.push(...r.warnings);
      }
      if (r && Object.keys(r.spec).length > 0) {
        resolved.push({ entry, r });
      }
    }

    const perHandlerOwners = new Map<string, Type>();
    for (const { entry, r } of resolved) {
      if (r.fallbackMethod) {
        const proto = entry.cls.prototype as Record<string, unknown>;
        if (typeof proto[r.fallbackMethod] !== "function") {
          throw new Error(
            `@Fallback('${r.fallbackMethod}') on ${r.source}: ${entry.cls.name} has no method "${r.fallbackMethod}".`,
          );
        }
        if (!entry.isStatic && !entry.isService) {
          throw new Error(
            `@Fallback('${r.fallbackMethod}') on ${r.source}: method fallbacks need a singleton ${entry.cls.name}; ` +
              `it is request-scoped or transient. Pass a function to @Fallback() instead.`,
          );
        }
      }

      if (r.perHandler.length > 0) {
        const owner = perHandlerOwners.get(r.source);
        if (owner && owner !== entry.cls) {
          const [kind, decorator] =
            r.perHandler[0] === "circuitBreaker"
              ? ["circuit breaker", "CircuitBreaker"]
              : ["bulkhead", "Bulkhead"];
          throw new Error(
            `Two handlers are named ${r.source} (two classes are called ${entry.cls.name}), so they would share ` +
              `one per-handler ${kind}. Give it a name: @${decorator}({ name: '...' }).`,
          );
        }
        perHandlerOwners.set(r.source, entry.cls);
      }

      onHandler(r.source, () => this.factory.declare(r.spec, r.source));
    }

    const planned = resolved.map(({ entry, r }) => {
      let byHandler = this.plans.get(entry.cls);
      if (!byHandler) {
        byHandler = new Map();
        this.plans.set(entry.cls, byHandler);
      }
      const plan = this.build(r);
      byHandler.set(entry.handler, plan);
      return { ...entry, plan };
    });

    return { planned, warnings };
  }

  private resolve(cls: Type, handler: Function): ResolvedEntrypoint | null {
    const method = methodKey(cls, handler);
    const source = `${cls.name}.${method}`;
    const base = {
      source,
      retryOnMethod: false,
      idempotent: false,
      requestStream: false,
      sse:
        MetadataRegistry.get(METADATA_KEYS.SSE, handler) === true ||
        MetadataRegistry.get(NEST_SSE_METADATA, handler) === true,
      perHandler: [] as Array<"circuitBreaker" | "bulkhead">,
      warnings: [] as string[],
    };

    if (
      MetadataRegistry.get(GRAPHQL_RESOLVER_TYPE, handler) === "Subscription"
    ) {
      if (
        RESILIENCE_METADATA_KEYS.some(
          (key) => MetadataRegistry.get(key, handler) !== undefined,
        )
      ) {
        base.warnings.push(
          `Resilience decorators on ${source}() have no effect: GraphQL subscriptions are not supported.`,
        );
      }
      return base.warnings.length ? { ...base, spec: {} } : null;
    }

    const levels: Function[] = MetadataRegistry.get(
      GRAPHQL_FIELD_RESOLVER,
      handler,
    )
      ? [handler]
      : [handler, cls];

    const presets = new Map<Function, ResiliencePreset | undefined>(
      levels.map((level) => {
        const name = MetadataRegistry.get<string>(PRESET_METADATA, level);
        return [
          level,
          name === undefined ? undefined : this.factory.presetOptions(name),
        ];
      }),
    );

    const findAll = <T = unknown>(
      stage: keyof ResiliencePreset,
    ): StageMatch<T>[] => {
      const matches: StageMatch<T>[] = [];
      for (const level of levels) {
        const key = STAGE_METADATA[stage];
        const explicit = key ? MetadataRegistry.get(key, level) : undefined;
        if (explicit !== undefined) {
          matches.push({ value: explicit as T, preset: false, level });
        }
        const preset = presets.get(level)?.[stage];
        if (preset !== undefined) {
          matches.push({ value: preset as T, preset: true, level });
        }
      }
      return matches;
    };

    const upTo = <T>(
      matches: StageMatch<T>[],
      whole: (m: StageMatch<T>) => boolean,
    ): StageMatch<T>[] => {
      const index = matches.findIndex(whole);
      return index === -1 ? matches : matches.slice(0, index + 1);
    };

    const spec: ResiliencePreset = {};
    let fallbackMethod: string | undefined;

    const fallbacks = upTo(findAll("fallback"), (m) => m.preset);
    if (fallbacks.length > 0 && handlesOwnResponse(cls, handler, method)) {
      base.warnings.push(
        `@Fallback() on ${source}() has no effect: the handler sends its own response through @Res() or ` +
          `@Next(). Use @Res({ passthrough: true }) to let Bunest send the fallback result.`,
      );
    } else if (fallbacks[0]?.preset) {
      spec.fallback = fallbacks[0].value as ResiliencePreset["fallback"];
    } else if (fallbacks.length > 0) {
      const decorators = fallbacks
        .filter((m) => !m.preset)
        .map((m) => m.value as FallbackMetadata);
      const first = decorators[0]!;
      const { method: namedMethod, fn } = first;
      fallbackMethod = namedMethod;
      const invokeFallback = fn
        ? (error: unknown, context: ExecutionContext) => fn(error, context)
        : (error: unknown, context: ExecutionContext) => {
            const aspectTarget =
              context &&
              typeof context === "object" &&
              "target" in context &&
              typeof (context as { target?: unknown }).target === "object" &&
              (context as { target?: unknown }).target !== null
                ? (context as { target: Record<string, unknown> }).target
                : undefined;
            const instance =
              aspectTarget && typeof aspectTarget[namedMethod!] === "function"
                ? aspectTarget
                : this.instanceOf(cls);
            const targetFn = instance[namedMethod!] as (
              err: unknown,
              ctx: ExecutionContext,
            ) => unknown;
            return targetFn.call(instance, error, context);
          };
      spec.fallback = {
        handler: ((error: unknown, _attempt: unknown, invocation?: unknown) =>
          invokeFallback(error, invocation as ExecutionContext)) as NonNullable<
          ResiliencePreset["fallback"]
        > extends infer F
          ? F extends { handler: infer H }
            ? H
            : never
          : never,
        handleIf: decorators.find((d) => d.handleIf)?.handleIf,
      };
    }

    const retries = upTo(findAll("retry"), (m) => m.preset);
    if (retries.length > 0) {
      const retry = retries.reduceRight<EntrypointRetryOptions>(
        (merged, { value, preset }) => {
          if (!preset) {
            return mergeRetry(merged, value as EntrypointRetryOptions);
          }
          const normalized = normalizeRetry(
            value as number | false | EntrypointRetryOptions,
          ) as EntrypointRetryOptions;
          const { idempotent: _ignored, ...options } = normalized;
          return mergeRetry(merged, options);
        },
        {},
      );
      base.idempotent = !!retry.idempotent;
      const { idempotent: _drop, ...options } = retry;
      spec.retry = options;
      base.retryOnMethod = retries.some(
        ({ level, preset }) => level === handler && !preset,
      );
      base.requestStream = readsRequestStream(handler);
    }

    for (const stage of ["circuitBreaker", "bulkhead"] as const) {
      const matches = upTo(
        findAll<CircuitBreakerOptions | BulkheadOptions | string>(stage),
        (m) => m.preset || isNamed(m.value),
      );
      if (matches.length === 0) {
        continue;
      }
      const merged = matches.reduceRight<Record<string, unknown>>(
        (acc, { value }) => ({
          ...acc,
          ...definedFields(typeof value === "string" ? { name: value } : value),
        }),
        {},
      );
      if (merged.name) {
        spec[stage] = merged as CircuitBreakerOptions & BulkheadOptions;
      } else {
        spec[stage] = {
          ...merged,
          name: source,
        } as CircuitBreakerOptions & BulkheadOptions;
        base.perHandler.push(stage);
      }
    }

    const rateLimit = findAll("outboundRateLimit")[0];
    if (rateLimit) {
      spec.outboundRateLimit =
        rateLimit.value as ResiliencePreset["outboundRateLimit"];
    }

    const timeouts = findAll<Duration | null>("timeout");
    if (timeouts.length > 0) {
      const timeout =
        timeouts.find(({ value }) => value !== undefined && value !== null)
          ?.value ?? this.factory.defaults.timeout;
      if (timeout === undefined || timeout === null) {
        throw new Error(
          `@Timeout() on ${source} has no duration and no defaults.timeout is configured.`,
        );
      }
      spec.timeout = timeout;
    }

    if (Object.keys(spec).length === 0 && base.warnings.length === 0) {
      return null;
    }
    return { ...base, spec, fallbackMethod };
  }

  private build({
    spec,
    source,
    retryOnMethod,
    idempotent,
    requestStream,
    sse,
  }: ResolvedEntrypoint): EntrypointPlan {
    const stages = onHandler(source, () =>
      this.factory.build(spec, source, source, { entrypoint: true }),
    );
    return {
      source,
      withRetry: this.factory.compose(stages),
      withoutRetry: this.factory.compose(stages, { retry: false }),
      hasRetry: !!stages.retry,
      idempotent,
      retryOnMethod,
      requestStream,
      sse,
    };
  }

  private instanceOf(cls: Type): Record<string, unknown> {
    let instance = this.instances.get(cls);
    if (!instance) {
      instance = this.moduleRef.get(cls, { strict: false }) as Record<
        string,
        unknown
      >;
      this.instances.set(cls, instance);
    }
    return instance;
  }
}

function onHandler<T>(source: string, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof OptionError) {
      throw new TypeError(
        `Resilience decorators on ${source}: ${error.message}`,
      );
    }
    throw error;
  }
}

function isNamed(value: unknown): boolean {
  return (
    typeof value === "string" ||
    Boolean(
      typeof value === "object" &&
      value !== null &&
      (value as { name?: unknown }).name,
    )
  );
}

function methodKey(cls: Type, handler: Function): string {
  const protoObj = cls.prototype as Record<string, unknown> | undefined;
  if (handler.name && protoObj?.[handler.name] === handler) {
    return handler.name;
  }
  for (
    let proto: object | null = cls.prototype as object | null;
    proto && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto) as object | null
  ) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (
        key !== "constructor" &&
        Object.getOwnPropertyDescriptor(proto, key)?.value === handler
      ) {
        return key;
      }
    }
  }
  return handler.name;
}

function handlesOwnResponse(
  cls: Type,
  handler: Function,
  method: string,
): boolean {
  const isHttp =
    MetadataRegistry.get(METADATA_KEYS.ROUTE_METHOD, handler) !== undefined ||
    MetadataRegistry.get(NEST_METHOD_METADATA, handler) !== undefined;
  if (!isHttp) {
    return false;
  }

  // Bunest parameter metadata
  const bunestParams = MetadataRegistry.getRouteParameters(cls, method);
  if (bunestParams.length > 0) {
    return bunestParams.some(
      (p) =>
        p.source === "next" ||
        (p.source === "response" && p.passthrough === false),
    );
  }

  // NestJS-compat fallback metadata
  const nestArgs = MetadataRegistry.get<Record<string, unknown>>(
    NEST_ROUTE_ARGS_METADATA,
    cls,
    method,
  );
  if (!nestArgs) {
    return false;
  }
  const manual = Object.keys(nestArgs).some((key) => {
    const type = Number(key.split(":")[0]);
    return type === 1 || type === 2; // RouteParamtypes.RESPONSE = 1, NEXT = 2
  });
  return (
    manual &&
    !MetadataRegistry.get(NEST_RESPONSE_PASSTHROUGH_METADATA, cls, method)
  );
}

function readsRequestStream(handler: Function): boolean {
  const patterns = MetadataRegistry.get(MICROSERVICES_PATTERN, handler);
  return (
    Array.isArray(patterns) &&
    patterns.some((p: { streaming?: unknown } | undefined) => {
      const streaming = p?.streaming;
      return streaming === "rx_stream" || streaming === "pt_stream";
    })
  );
}
