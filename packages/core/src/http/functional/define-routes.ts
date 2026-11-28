import {
  DESIGN_METADATA_KEYS,
  HttpStatus,
  InternalServerErrorException,
  METADATA_KEYS,
  MetadataRegistry,
  StreamableFile,
  formatStandardSchemaIssues,
  invalidateControllerCache,
  type ControllerMetadata,
  type ExceptionFilterLike,
  type ExecutionContext,
  type GuardLike,
  type HeaderMetadata,
  type InjectionToken,
  type InterceptorLike,
  type ModuleExport,
  type ModuleImport,
  type ParameterMetadata,
  type PipeLike,
  type Provider,
  type ResponseContext,
  type RouteHttpMethod,
  type RouteMethodMetadata,
  type StandardSchemaV1,
  type StandardSchemaV1InferOutput,
  type Type,
  type VersionValue,
} from "../../common/index";
import { ContextIdFactory } from "../../di/context-id.factory";
import { ModuleRef } from "../../di/module-ref";
import { getCurrentRequestContext } from "../context/request-context";

export const FUNCTIONAL_ROUTE_GROUP_MARKER = Symbol.for(
  "bunest:http:functional_route_group",
);

// Zero-dep cross-package metadata bridges read by `@bunest/swagger` (preserves acyclic package DAG)
const SWAGGER_API_TAGS_KEY = Symbol.for("bunest:swagger:api_tags");
const SWAGGER_API_OPERATION_KEY = Symbol.for("bunest:swagger:api_operation");
const STANDARD_SCHEMA_SERIALIZER_KEY = Symbol.for(
  "bunest:validation:standard_schema_serializer",
);

/** Infers the validated output type of a Standard Schema v1 or falls back to `TFallback`. */
type InferSchemaOutput<TSchema, TFallback> = TSchema extends StandardSchemaV1
  ? StandardSchemaV1InferOutput<TSchema>
  : TFallback;

/**
 * Per-request execution context passed to functional route handlers defined with `defineRoutes()`.
 * Provides typed `params`/`query`/`body`, native `Request`/`ResponseContext`, and DI lookups.
 */
export interface FunctionalRouteContext<
  TParams = Record<string, string>,
  TQuery = Record<string, string | string[]>,
  TBody = unknown,
> {
  readonly request: Request;
  readonly req: Request;
  readonly response: ResponseContext;
  readonly res: ResponseContext;
  readonly params: TParams;
  readonly query: TQuery;
  readonly body: TBody;
  readonly headers: Headers;
  readonly cookies: Record<string, string>;
  readonly ip: string;
  readonly pathname: string;
  readonly executionContext: ExecutionContext;
  /** Synchronously resolves a singleton provider from the DI container. */
  get<T = unknown>(
    token: InjectionToken<T>,
    options?: { readonly strict?: boolean },
  ): T;
  /** Asynchronously resolves a provider (including request/transient scopes) from DI. */
  resolve<T = unknown>(
    token: InjectionToken<T>,
    options?: { readonly strict?: boolean },
  ): Promise<T>;
}

/** Handler function registered on a functional route. */
export type FunctionalRouteHandler<
  TParams = Record<string, string>,
  TQuery = Record<string, string | string[]>,
  TBody = unknown,
  TResponse = unknown,
> = (
  ctx: FunctionalRouteContext<TParams, TQuery, TBody>,
) => TResponse | Response | Promise<TResponse | Response>;

/** Per-route configuration options accepted by `.get/.post/.put/.patch/.delete(...)`. */
export interface FunctionalRouteOptions<
  TParamsSchema extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
  TQuerySchema extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
  TBodySchema extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
  TResponseSchema extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
> {
  readonly guards?: readonly GuardLike[];
  readonly pipes?: readonly PipeLike[];
  readonly interceptors?: readonly InterceptorLike[];
  readonly filters?: readonly ExceptionFilterLike[];
  readonly bodySchema?: TBodySchema;
  readonly querySchema?: TQuerySchema;
  readonly paramsSchema?: TParamsSchema;
  readonly responseSchema?: TResponseSchema;
  readonly httpCode?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly version?: VersionValue;
  /** Optional OpenAPI operation summary emitted for `@bunest/swagger`. */
  readonly summary?: string;
  /** Optional OpenAPI operation description emitted for `@bunest/swagger`. */
  readonly description?: string;
  /** Optional OpenAPI operation tags overriding/supplementing group tags. */
  readonly tags?: readonly string[];
  /** Optional explicit OpenAPI `operationId`. */
  readonly operationId?: string;
  /** Marks the route as deprecated in OpenAPI metadata. */
  readonly deprecated?: boolean;
  /**
   * Controls whether the HTTP pipeline parses a request body parameter for this route.
   * Defaults to `true` when `bodySchema` is provided or method is not `GET`/`HEAD`.
   */
  readonly parseBody?: boolean;
}

/** Group-level options accepted as the first argument to `defineRoutes(options, builder)`. */
export interface FunctionalRouteGroupOptions {
  readonly prefix?: string;
  readonly guards?: readonly GuardLike[];
  readonly pipes?: readonly PipeLike[];
  readonly interceptors?: readonly InterceptorLike[];
  readonly filters?: readonly ExceptionFilterLike[];
  readonly version?: VersionValue;
  readonly host?: string | RegExp | Array<string | RegExp>;
  /** Optional OpenAPI tags applied to every route in this group. */
  readonly tags?: readonly string[];
}

/** Normalized single route entry stored inside a `FunctionalRouteGroup`. */
export interface FunctionalRouteEntry {
  readonly method: RouteHttpMethod;
  readonly path: string;
  readonly options: FunctionalRouteOptions;
  readonly handler: FunctionalRouteHandler<any, any, any, any>;
}

/** Immutable route group returned by `defineRoutes()` and registered via `FunctionalModule.forRoutes()`. */
export interface FunctionalRouteGroup {
  readonly [FUNCTIONAL_ROUTE_GROUP_MARKER]: true;
  readonly prefix: string;
  readonly routes: readonly FunctionalRouteEntry[];
  readonly guards?: readonly GuardLike[];
  readonly pipes?: readonly PipeLike[];
  readonly interceptors?: readonly InterceptorLike[];
  readonly filters?: readonly ExceptionFilterLike[];
  readonly version?: VersionValue;
  readonly host?: string | RegExp | Array<string | RegExp>;
  readonly tags?: readonly string[];
}

type VerbMethodFn = {
  <TResponse = unknown>(
    path: string,
    handler: FunctionalRouteHandler<
      Record<string, string>,
      Record<string, string | string[]>,
      unknown,
      TResponse
    >,
  ): FunctionalRouteBuilder;
  <
    TParamsSchema extends StandardSchemaV1 | undefined = undefined,
    TQuerySchema extends StandardSchemaV1 | undefined = undefined,
    TBodySchema extends StandardSchemaV1 | undefined = undefined,
    TResponseSchema extends StandardSchemaV1 | undefined = undefined,
    TResponse = InferSchemaOutput<TResponseSchema, unknown>,
  >(
    path: string,
    options: FunctionalRouteOptions<
      TParamsSchema,
      TQuerySchema,
      TBodySchema,
      TResponseSchema
    >,
    handler: FunctionalRouteHandler<
      InferSchemaOutput<TParamsSchema, Record<string, string>>,
      InferSchemaOutput<TQuerySchema, Record<string, string | string[]>>,
      InferSchemaOutput<TBodySchema, unknown>,
      TResponse
    >,
  ): FunctionalRouteBuilder;
};

/** Fluent route builder passed into `defineRoutes(prefix, builder)`. */
export interface FunctionalRouteBuilder {
  readonly get: VerbMethodFn;
  readonly post: VerbMethodFn;
  readonly put: VerbMethodFn;
  readonly patch: VerbMethodFn;
  readonly delete: VerbMethodFn;
  readonly head: VerbMethodFn;
  readonly options: VerbMethodFn;
  readonly all: VerbMethodFn;
  route<TResponse = unknown>(
    method: RouteHttpMethod,
    path: string,
    handler: FunctionalRouteHandler<
      Record<string, string>,
      Record<string, string | string[]>,
      unknown,
      TResponse
    >,
  ): FunctionalRouteBuilder;
  route<
    TParamsSchema extends StandardSchemaV1 | undefined = undefined,
    TQuerySchema extends StandardSchemaV1 | undefined = undefined,
    TBodySchema extends StandardSchemaV1 | undefined = undefined,
    TResponseSchema extends StandardSchemaV1 | undefined = undefined,
    TResponse = InferSchemaOutput<TResponseSchema, unknown>,
  >(
    method: RouteHttpMethod,
    path: string,
    options: FunctionalRouteOptions<
      TParamsSchema,
      TQuerySchema,
      TBodySchema,
      TResponseSchema
    >,
    handler: FunctionalRouteHandler<
      InferSchemaOutput<TParamsSchema, Record<string, string>>,
      InferSchemaOutput<TQuerySchema, Record<string, string | string[]>>,
      InferSchemaOutput<TBodySchema, unknown>,
      TResponse
    >,
  ): FunctionalRouteBuilder;
}

/** Optional object configuration for `FunctionalModule.forRoutes(...)`. */
export interface FunctionalModuleOptions {
  readonly routes: readonly FunctionalRouteGroup[];
  readonly imports?: ModuleImport[];
  readonly providers?: Provider[];
  readonly exports?: ModuleExport[];
}

function isNativeResponsePassthrough(value: unknown): boolean {
  if (value === null || value === undefined || typeof value !== "object") {
    return false;
  }
  if (value instanceof StreamableFile) return true;
  if (typeof Response !== "undefined" && value instanceof Response) return true;
  if (
    typeof ReadableStream !== "undefined" &&
    value instanceof ReadableStream
  ) {
    return true;
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) return true;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true;
  return false;
}

/** Type guard checking whether `value` is a `FunctionalRouteGroup`. */
export function isFunctionalRouteGroup(
  value: unknown,
): value is FunctionalRouteGroup {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[FUNCTIONAL_ROUTE_GROUP_MARKER] ===
      true
  );
}

/**
 * Defines a lightweight, decorator-less group of HTTP routes that compile
 * directly into Bunest's native 11-stage HTTP pipeline & router via
 * `FunctionalModule.forRoutes(...)`.
 */
export function defineRoutes(
  prefixOrOptions: string | FunctionalRouteGroupOptions,
  builder: (routes: FunctionalRouteBuilder) => unknown,
): FunctionalRouteGroup {
  if (typeof builder !== "function") {
    throw new TypeError("defineRoutes() requires a builder callback function.");
  }

  const groupOpts: FunctionalRouteGroupOptions =
    typeof prefixOrOptions === "string"
      ? { prefix: prefixOrOptions }
      : (prefixOrOptions ?? {});
  const prefix = groupOpts.prefix ?? "";
  const entries: FunctionalRouteEntry[] = [];

  const register = (
    method: RouteHttpMethod,
    path: string,
    optsOrHandler:
      | FunctionalRouteOptions<any, any, any, any>
      | FunctionalRouteHandler<any, any, any, any>,
    maybeHandler?: FunctionalRouteHandler<any, any, any, any>,
  ): FunctionalRouteBuilder => {
    let options: FunctionalRouteOptions;
    let handler: FunctionalRouteHandler<any, any, any, any>;

    if (typeof optsOrHandler === "function") {
      options = {};
      handler = optsOrHandler;
    } else {
      options = optsOrHandler ?? {};
      if (typeof maybeHandler !== "function") {
        throw new TypeError(
          `defineRoutes(): route ${method} "${path}" requires a handler function.`,
        );
      }
      handler = maybeHandler;
    }

    entries.push(
      Object.freeze({
        method,
        path,
        options,
        handler,
      }),
    );
    return routeBuilder;
  };

  const makeVerb = (method: RouteHttpMethod): VerbMethodFn =>
    ((
      path: string,
      optsOrHandler:
        | FunctionalRouteOptions<any, any, any, any>
        | FunctionalRouteHandler<any, any, any, any>,
      maybeHandler?: FunctionalRouteHandler<any, any, any, any>,
    ) =>
      register(
        method,
        path,
        optsOrHandler,
        maybeHandler,
      )) as VerbMethodFn;

  const routeBuilder: FunctionalRouteBuilder = {
    get: makeVerb("GET"),
    post: makeVerb("POST"),
    put: makeVerb("PUT"),
    patch: makeVerb("PATCH"),
    delete: makeVerb("DELETE"),
    head: makeVerb("HEAD"),
    options: makeVerb("OPTIONS"),
    all: makeVerb("ALL"),
    route: register as FunctionalRouteBuilder["route"],
  };

  builder(routeBuilder);

  return Object.freeze({
    [FUNCTIONAL_ROUTE_GROUP_MARKER]: true as const,
    prefix,
    routes: Object.freeze(entries),
    ...(groupOpts.guards ? { guards: [...groupOpts.guards] } : {}),
    ...(groupOpts.pipes ? { pipes: [...groupOpts.pipes] } : {}),
    ...(groupOpts.interceptors
      ? { interceptors: [...groupOpts.interceptors] }
      : {}),
    ...(groupOpts.filters ? { filters: [...groupOpts.filters] } : {}),
    ...(groupOpts.version !== undefined ? { version: groupOpts.version } : {}),
    ...(groupOpts.host !== undefined ? { host: groupOpts.host } : {}),
    ...(groupOpts.tags && groupOpts.tags.length > 0
      ? { tags: [...groupOpts.tags] }
      : {}),
  });
}

let functionalControllerSeq = 0;

function sanitizeControllerSuffix(prefix: string): string {
  const cleaned = prefix
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "Root";
}

function defaultTagFromPrefix(prefix: string): string | undefined {
  const segments = prefix
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith(":") && !s.startsWith("*"));
  return segments[segments.length - 1];
}

export function compileFunctionalGroupToController(
  group: FunctionalRouteGroup,
): Type<unknown> {
  const seq = ++functionalControllerSeq;
  const className = `FunctionalRoutes_${sanitizeControllerSuffix(group.prefix)}_${seq}`;

  class DynamicFunctionalController {
    constructor(public readonly moduleRef: ModuleRef) {}
  }

  Object.defineProperty(DynamicFunctionalController, "name", {
    value: className,
    configurable: true,
  });

  // Register DI constructor metadata so DIContainer injects ModuleRef automatically
  MetadataRegistry.define(
    DESIGN_METADATA_KEYS.PARAMTYPES,
    [ModuleRef],
    DynamicFunctionalController,
  );

  const controllerMeta: ControllerMetadata = {
    path: group.prefix,
    ...(group.version !== undefined ? { version: group.version } : {}),
    ...(group.host !== undefined ? { host: group.host } : {}),
  };
  MetadataRegistry.define(
    METADATA_KEYS.CONTROLLER,
    controllerMeta,
    DynamicFunctionalController,
  );

  const resolvedGroupTags =
    group.tags && group.tags.length > 0
      ? [...group.tags]
      : (() => {
          const inferred = defaultTagFromPrefix(group.prefix);
          return inferred ? [inferred] : undefined;
        })();
  if (resolvedGroupTags && resolvedGroupTags.length > 0) {
    MetadataRegistry.define(
      SWAGGER_API_TAGS_KEY,
      resolvedGroupTags,
      DynamicFunctionalController,
    );
  }

  if (group.guards && group.guards.length > 0) {
    MetadataRegistry.define(
      METADATA_KEYS.GUARDS,
      [...group.guards],
      DynamicFunctionalController,
    );
  }
  if (group.pipes && group.pipes.length > 0) {
    MetadataRegistry.define(
      METADATA_KEYS.PIPES,
      [...group.pipes],
      DynamicFunctionalController,
    );
  }
  if (group.interceptors && group.interceptors.length > 0) {
    MetadataRegistry.define(
      METADATA_KEYS.INTERCEPTORS,
      [...group.interceptors],
      DynamicFunctionalController,
    );
  }
  if (group.filters && group.filters.length > 0) {
    MetadataRegistry.define(
      METADATA_KEYS.EXCEPTION_FILTERS,
      [...group.filters],
      DynamicFunctionalController,
    );
  }

  const routeMethods: RouteMethodMetadata[] = [];

  for (let i = 0; i < group.routes.length; i++) {
    const entry = group.routes[i]!;
    const handlerKey = `route_${i}_${entry.method.toLowerCase()}`;
    const opts = entry.options;
    const includeBody =
      opts.parseBody !== undefined
        ? opts.parseBody
        : opts.bodySchema !== undefined ||
          (entry.method !== "GET" && entry.method !== "HEAD");

    const handlerFn = async function (
      this: DynamicFunctionalController,
      params: unknown,
      query: unknown,
      body: unknown,
      request: Request,
      response: ResponseContext,
      executionContext: ExecutionContext,
    ): Promise<unknown> {
      const reqCtx = getCurrentRequestContext();
      const moduleRef = this.moduleRef;

      const fnCtx: FunctionalRouteContext<any, any, any> = {
        request,
        req: request,
        response,
        res: response,
        params: params ?? {},
        query: query ?? {},
        body,
        headers: request.headers,
        get cookies(): Record<string, string> {
          return reqCtx ? reqCtx.cookies : {};
        },
        get ip(): string {
          return reqCtx ? reqCtx.ip : "";
        },
        get pathname(): string {
          return reqCtx ? reqCtx.pathname : new URL(request.url).pathname;
        },
        executionContext,
        get<T = unknown>(
          token: InjectionToken<T>,
          getOpts?: { readonly strict?: boolean },
        ): T {
          return moduleRef.get<T>(token, {
            strict: getOpts?.strict ?? false,
          });
        },
        resolve<T = unknown>(
          token: InjectionToken<T>,
          resolveOpts?: { readonly strict?: boolean },
        ): Promise<T> {
          const contextOrContainer =
            reqCtx?.container ?? ContextIdFactory.getByRequest(request);
          return moduleRef.resolve<T>(token, contextOrContainer, {
            strict: resolveOpts?.strict ?? false,
          });
        },
      };

      const result = await entry.handler(fnCtx);

      if (
        opts.responseSchema !== undefined &&
        result !== undefined &&
        !isNativeResponsePassthrough(result)
      ) {
        const validated = await opts.responseSchema["~standard"].validate(
          result,
        );
        if (validated.issues) {
          const details = formatStandardSchemaIssues(
            validated.issues,
            "response",
          );
          throw new InternalServerErrorException({
            statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
            error: "Internal Server Error",
            message: "Response validation failed",
            details,
          });
        }
        return validated.value;
      }

      return result;
    };

    Object.defineProperty(handlerFn, "name", {
      value: handlerKey,
      configurable: true,
    });

    (
      DynamicFunctionalController.prototype as unknown as Record<
        string,
        unknown
      >
    )[handlerKey] = handlerFn;

    const paramsMeta: ParameterMetadata[] = [
      {
        index: 0,
        source: "param",
        ...(opts.paramsSchema !== undefined
          ? { schema: opts.paramsSchema }
          : {}),
      },
      {
        index: 1,
        source: "query",
        ...(opts.querySchema !== undefined ? { schema: opts.querySchema } : {}),
      },
      includeBody
        ? {
            index: 2,
            source: "body",
            ...(opts.bodySchema !== undefined
              ? { schema: opts.bodySchema }
              : {}),
          }
        : {
            index: 2,
            source: "custom",
            factory: () => undefined,
          },
      { index: 3, source: "request" },
      { index: 4, source: "response" },
      {
        index: 5,
        source: "custom",
        factory: (_data, execCtx) => execCtx,
      },
    ];

    MetadataRegistry.define(
      METADATA_KEYS.ROUTE_PARAMS,
      paramsMeta,
      DynamicFunctionalController.prototype,
      handlerKey,
    );

    if (opts.guards && opts.guards.length > 0) {
      MetadataRegistry.define(METADATA_KEYS.GUARDS, [...opts.guards], handlerFn);
    }
    if (opts.pipes && opts.pipes.length > 0) {
      MetadataRegistry.define(METADATA_KEYS.PIPES, [...opts.pipes], handlerFn);
    }
    if (opts.interceptors && opts.interceptors.length > 0) {
      MetadataRegistry.define(
        METADATA_KEYS.INTERCEPTORS,
        [...opts.interceptors],
        handlerFn,
      );
    }
    if (opts.filters && opts.filters.length > 0) {
      MetadataRegistry.define(
        METADATA_KEYS.EXCEPTION_FILTERS,
        [...opts.filters],
        handlerFn,
      );
    }
    if (opts.httpCode !== undefined) {
      MetadataRegistry.define(METADATA_KEYS.HTTP_CODE, opts.httpCode, handlerFn);
    }
    if (opts.headers) {
      const headerList: HeaderMetadata[] = Object.entries(opts.headers).map(
        ([name, value]) => ({ name, value }),
      );
      if (headerList.length > 0) {
        MetadataRegistry.define(METADATA_KEYS.HEADERS, headerList, handlerFn);
      }
    }
    if (opts.version !== undefined) {
      MetadataRegistry.define(METADATA_KEYS.VERSION, opts.version, handlerFn);
    }

    // Bridge OpenAPI metadata & response Standard Schema to `@bunest/swagger` without runtime imports
    if (opts.responseSchema !== undefined) {
      MetadataRegistry.define(
        STANDARD_SCHEMA_SERIALIZER_KEY,
        { schema: opts.responseSchema },
        handlerFn,
      );
    }
    if (opts.tags && opts.tags.length > 0) {
      MetadataRegistry.define(SWAGGER_API_TAGS_KEY, [...opts.tags], handlerFn);
    }
    if (
      opts.summary !== undefined ||
      opts.description !== undefined ||
      opts.operationId !== undefined ||
      opts.deprecated !== undefined
    ) {
      MetadataRegistry.define(
        SWAGGER_API_OPERATION_KEY,
        {
          ...(opts.summary !== undefined ? { summary: opts.summary } : {}),
          ...(opts.description !== undefined
            ? { description: opts.description }
            : {}),
          ...(opts.operationId !== undefined
            ? { operationId: opts.operationId }
            : {}),
          ...(opts.deprecated !== undefined
            ? { deprecated: opts.deprecated }
            : {}),
        },
        handlerFn,
      );
    }

    MetadataRegistry.define(METADATA_KEYS.ROUTE_METHOD, entry.method, handlerFn);
    MetadataRegistry.define(METADATA_KEYS.ROUTE_PATH, entry.path, handlerFn);

    routeMethods.push({
      method: entry.method,
      path: entry.path,
      handlerKey,
    });
  }

  MetadataRegistry.define(
    METADATA_KEYS.ROUTES,
    routeMethods,
    DynamicFunctionalController,
  );
  invalidateControllerCache(DynamicFunctionalController);

  return DynamicFunctionalController;
}
