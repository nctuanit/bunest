import type { BunestRouteRegistry } from "../common/interfaces/registries.interface";
import type { StandardSchemaV1 } from "../common/interfaces/standard-schema.interface";
import { HttpClient } from "./http-client";
import type { HttpClientOptions } from "./interfaces/http-client-options.interface";
import type {
  HttpQuery,
  HttpRequestBody,
  HttpRequestOptions,
} from "./interfaces/http-request.interface";
import type { HttpResponse } from "./interfaces/http-response.interface";

/** HTTP methods exposed as path-keyed methods on `TypedClient`. */
export type TypedClientHttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS";

/**
 * Structural description of a single HTTP route entry.
 * Matches both `BunestRouteRegistry` entries emitted by `bunest typegen`
 * and standalone frontend-portable `AppRoutes` definitions.
 */
export interface RouteDefinition {
  readonly method: string;
  readonly path: string;
  readonly params?: unknown;
  readonly query?: unknown;
  readonly body?: unknown;
  readonly response?: unknown;
  readonly controller?: string;
  readonly handler?: string;
}

/**
 * Structural constraint for route registries accepted by `createTypedClient<TRoutes>()`
 * and `createRpcClient<TRoutes>()`. Compatible with both TypeScript `interface`
 * declarations (such as `BunestRouteRegistry` or `AppRoutes`) and `type` aliases.
 */
export type RouteRegistryLike<T = object> = {
  readonly [K in keyof T]: RouteDefinition;
};

/**
 * Runtime route metadata entry used by `$rpc` / `createRpcClient` to map
 * `<controller>.<handler>` calls onto an HTTP method and path template.
 */
export interface RouteManifestEntry {
  readonly method: string;
  readonly path: string;
  readonly controller?: string;
  readonly handler?: string;
}

/**
 * Runtime route manifest accepted by `createTypedClient({ manifest })` and
 * `createRpcClient({ manifest })`.
 *
 * Accepts:
 * - A flat map keyed by route key (e.g. `appRouteManifest` from `bunest typegen --client-types`)
 * - An array of `RouteManifestEntry` records
 * - A nested `{ [controller]: { [handler]: { method, path } } }` lookup map
 */
export type RouteManifestLike =
  | ReadonlyArray<RouteManifestEntry>
  | Readonly<Record<string, RouteManifestEntry>>
  | Readonly<Record<string, Readonly<Record<string, RouteManifestEntry>>>>;

/** Options for `createTypedClient<TRoutes>(options)`. */
export interface TypedClientOptions extends HttpClientOptions {
  /**
   * Optional pre-configured `HttpClient` instance (for example, injected via
   * `HttpClientModule`). When omitted, a new `HttpClient` is created from the
   * remaining options.
   */
  readonly client?: HttpClient | undefined;
  /**
   * Optional route manifest enabling `client.$rpc.<controller>.<handler>(...)`.
   * Generate one with `bunest typegen --client-types <output.ts>`.
   */
  readonly manifest?: RouteManifestLike | undefined;
}

/** Options for `createRpcClient<TRoutes>(options)`. */
export interface RpcClientOptions extends HttpClientOptions {
  /** Optional pre-configured `HttpClient` instance. */
  readonly client?: HttpClient | undefined;
  /** Route manifest mapping `<controller>.<handler>` calls to HTTP method & path. */
  readonly manifest: RouteManifestLike;
}

// ============================================================================
// Type-Level Route Introspection & Request/Response Inference
// ============================================================================

type IsAny<T> = 0 extends 1 & T ? true : false;
type IsNever<T> = [T] extends [never] ? true : false;

type IsEmptyRecord<T> = IsAny<T> extends true
  ? false
  : IsNever<T> extends true
    ? true
    : [T] extends [undefined | void]
      ? true
      : [T] extends [Record<string, never>]
        ? true
        : false;

type HasRequiredKeys<T> = IsAny<T> extends true
  ? false
  : IsNever<T> extends true
    ? false
    : [T] extends [undefined | void]
      ? false
      : {} extends T
        ? false
        : true;

type IsNoBody<T> = IsAny<T> extends true
  ? false
  : IsNever<T> extends true
    ? true
    : [T] extends [undefined | void]
      ? true
      : false;

type IsBodyRequired<T> = IsAny<T> extends true
  ? false
  : IsNoBody<T> extends true
    ? false
    : undefined extends T
      ? false
      : true;

type ExtractPathParamNames<TPath extends string> =
  TPath extends `${string}/:${infer Param}/${infer Rest}`
    ? Param | ExtractPathParamNames<`/${Rest}`>
    : TPath extends `${string}/:${infer Param}`
      ? Param
      : TPath extends `:${infer Param}/${infer Rest}`
        ? Param | ExtractPathParamNames<`/${Rest}`>
        : TPath extends `:${infer Param}`
          ? Param
          : never;

/** Valid path templates for a specific HTTP method in `TRoutes`. */
export type RoutePathsForMethod<
  TRoutes extends RouteRegistryLike,
  TMethod extends TypedClientHttpMethod,
> = {
  [K in keyof TRoutes]: TRoutes[K] extends {
    readonly method: infer M extends string;
    readonly path: infer P extends string;
  }
    ? Uppercase<M> extends TMethod | "ALL"
      ? P
      : never
    : never;
}[keyof TRoutes];

/** Resolve the `RouteDefinition` entry for a given `(TMethod, TPath)` pair. */
export type RouteEntryFor<
  TRoutes extends RouteRegistryLike,
  TMethod extends TypedClientHttpMethod,
  TPath extends string,
> = `${TMethod} ${TPath}` extends keyof TRoutes
  ? TRoutes[`${TMethod} ${TPath}`]
  : `ALL ${TPath}` extends keyof TRoutes
    ? TRoutes[`ALL ${TPath}`]
    : {
        [K in keyof TRoutes]: TRoutes[K] extends {
          readonly method: infer M extends string;
          readonly path: TPath;
        }
          ? Uppercase<M> extends TMethod | "ALL"
            ? TRoutes[K]
            : never
          : never;
      }[keyof TRoutes];

/** Extract the path params type from a `RouteDefinition`. */
export type RouteDefParams<TDef> = TDef extends { readonly params: infer P }
  ? P
  : TDef extends { readonly path: infer Path extends string }
    ? [ExtractPathParamNames<Path>] extends [never]
      ? Record<string, never>
      : { readonly [K in ExtractPathParamNames<Path>]: string | number }
    : Record<string, never>;

/** Extract the query params type from a `RouteDefinition`. */
export type RouteDefQuery<TDef> = TDef extends { readonly query: infer Q }
  ? Q
  : Record<string, unknown>;

/** Extract the request body type from a `RouteDefinition`. */
export type RouteDefBody<TDef> = TDef extends { readonly body: infer B }
  ? B
  : never;

/** Extract the response payload type from a `RouteDefinition`. */
export type RouteDefResponse<TDef> = TDef extends { readonly response: infer R }
  ? R
  : unknown;

/** Base per-request `HttpClient` options forwarded by `TypedClient` calls. */
export type TypedRequestBaseOptions = Omit<
  HttpRequestOptions,
  "method" | "params" | "query" | "body" | "json" | "responseSchema"
>;

type ParamsOptionField<TParams> = IsEmptyRecord<TParams> extends true
  ? { readonly params?: undefined }
  : HasRequiredKeys<TParams> extends true
    ? { readonly params: TParams }
    : { readonly params?: TParams | undefined };

type QueryOptionField<TQuery> = IsEmptyRecord<TQuery> extends true
  ? { readonly query?: undefined }
  : HasRequiredKeys<TQuery> extends true
    ? { readonly query: TQuery }
    : { readonly query?: TQuery | undefined };

type BodyOptionField<TBody> = IsNoBody<TBody> extends true
  ? { readonly body?: undefined }
  : IsBodyRequired<TBody> extends true
    ? { readonly body: TBody }
    : { readonly body?: TBody | undefined };

type IsRouteOptionsRequired<TDef> =
  HasRequiredKeys<RouteDefParams<TDef>> extends true
    ? true
    : HasRequiredKeys<RouteDefQuery<TDef>> extends true
      ? true
      : IsBodyRequired<RouteDefBody<TDef>>;

/** Per-route request options derived from `TDef`. */
export type TypedRouteCallOptions<TDef> = TypedRequestBaseOptions &
  ParamsOptionField<RouteDefParams<TDef>> &
  QueryOptionField<RouteDefQuery<TDef>> &
  BodyOptionField<RouteDefBody<TDef>> & {
    readonly responseSchema?: undefined;
  };

/** Per-route request options with a runtime `responseSchema` validator override. */
export type TypedRouteCallOptionsWithSchema<TDef, TValidated> =
  TypedRequestBaseOptions &
    ParamsOptionField<RouteDefParams<TDef>> &
    QueryOptionField<RouteDefQuery<TDef>> &
    BodyOptionField<RouteDefBody<TDef>> & {
      readonly responseSchema: StandardSchemaV1<unknown, TValidated>;
    };

/** Optional or required tuple for a route's options parameter. */
export type TypedRouteCallArgs<TDef> =
  IsRouteOptionsRequired<TDef> extends true
    ? [options: TypedRouteCallOptions<TDef>]
    : [options?: TypedRouteCallOptions<TDef>];

/** Path-keyed typed HTTP verb function for method `TMethod`. */
export type TypedHttpMethodFn<
  TRoutes extends RouteRegistryLike,
  TMethod extends TypedClientHttpMethod,
> = {
  <TPath extends RoutePathsForMethod<TRoutes, TMethod>, TValidated>(
    path: TPath,
    options: TypedRouteCallOptionsWithSchema<
      RouteEntryFor<TRoutes, TMethod, TPath>,
      TValidated
    >,
  ): Promise<HttpResponse<TValidated>>;
  <TPath extends RoutePathsForMethod<TRoutes, TMethod>>(
    path: TPath,
    ...args: TypedRouteCallArgs<RouteEntryFor<TRoutes, TMethod, TPath>>
  ): Promise<
    HttpResponse<RouteDefResponse<RouteEntryFor<TRoutes, TMethod, TPath>>>
  >;
};

/** Controller names discovered across `TRoutes`. */
export type RouteControllerNames<TRoutes extends RouteRegistryLike> = {
  [K in keyof TRoutes]: TRoutes[K] extends {
    readonly controller: infer C extends string;
  }
    ? C
    : never;
}[keyof TRoutes];

type RoutesForController<
  TRoutes extends RouteRegistryLike,
  TController extends string,
> = {
  [K in keyof TRoutes]: TRoutes[K] extends {
    readonly controller: TController;
    readonly handler: string;
  }
    ? TRoutes[K]
    : never;
}[keyof TRoutes];

/** Handler method names belonging to `TController` in `TRoutes`. */
export type ControllerHandlerNames<
  TRoutes extends RouteRegistryLike,
  TController extends string,
> = RoutesForController<TRoutes, TController> extends infer R
  ? R extends { readonly handler: infer H extends string }
    ? H
    : never
  : never;

type RouteEntryByControllerHandler<
  TRoutes extends RouteRegistryLike,
  TController extends string,
  THandler extends string,
> = Extract<
  TRoutes[keyof TRoutes],
  { readonly controller: TController; readonly handler: THandler }
>;

/** Typed RPC method signature for a single route definition `TDef`. */
export type TypedRouteCall<TDef> = {
  <TValidated>(
    options: TypedRouteCallOptionsWithSchema<TDef, TValidated>,
  ): Promise<HttpResponse<TValidated>>;
  (
    ...args: TypedRouteCallArgs<TDef>
  ): Promise<HttpResponse<RouteDefResponse<TDef>>>;
};

/** Nested RPC proxy (`$rpc.<controller>.<handler>(options)`). */
export type RpcClient<TRoutes extends RouteRegistryLike> = {
  readonly [C in RouteControllerNames<TRoutes>]: {
    readonly [H in ControllerHandlerNames<TRoutes, C>]: TypedRouteCall<
      RouteEntryByControllerHandler<TRoutes, C, H>
    >;
  };
};

/** End-to-end typed HTTP & RPC client over a `RouteRegistryLike`. */
export interface TypedClient<TRoutes extends RouteRegistryLike> {
  readonly get: TypedHttpMethodFn<TRoutes, "GET">;
  readonly post: TypedHttpMethodFn<TRoutes, "POST">;
  readonly put: TypedHttpMethodFn<TRoutes, "PUT">;
  readonly patch: TypedHttpMethodFn<TRoutes, "PATCH">;
  readonly delete: TypedHttpMethodFn<TRoutes, "DELETE">;
  readonly head: TypedHttpMethodFn<TRoutes, "HEAD">;
  readonly options: TypedHttpMethodFn<TRoutes, "OPTIONS">;
  /** Controller/handler RPC proxy backed by the configured route `manifest`. */
  readonly $rpc: RpcClient<TRoutes>;
  /** Underlying `HttpClient` transport instance. */
  readonly http: HttpClient;
}

// ============================================================================
// Runtime Implementation (Browser & Bun Compatible — Standard Fetch Only)
// ============================================================================

interface RawTypedCallOptions extends TypedRequestBaseOptions {
  readonly params?: Record<string, unknown> | undefined;
  readonly query?: unknown;
  readonly body?: unknown;
  readonly responseSchema?: StandardSchemaV1<unknown, unknown> | undefined;
}

interface ResolvedManifestRoute {
  readonly method: string;
  readonly path: string;
}

const PROXY_PASSTHROUGH_KEYS = new Set<string>([
  "then",
  "catch",
  "finally",
  "toJSON",
  "toString",
  "valueOf",
  "constructor",
  "$$typeof",
]);

function isRawFetchBody(value: unknown): value is HttpRequestBody {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    return true;
  }
  if (typeof FormData !== "undefined" && value instanceof FormData) {
    return true;
  }
  if (
    typeof URLSearchParams !== "undefined" &&
    value instanceof URLSearchParams
  ) {
    return true;
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return true;
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return true;
  }
  if (
    typeof ReadableStream !== "undefined" &&
    value instanceof ReadableStream
  ) {
    return true;
  }
  if (
    typeof value === "object" &&
    Symbol.asyncIterator in value &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] ===
      "function"
  ) {
    return true;
  }
  return false;
}

function isRouteManifestEntry(value: unknown): value is RouteManifestEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.method === "string" && typeof candidate.path === "string"
  );
}

function normalizeRouteManifest(
  manifest: RouteManifestLike | undefined,
): Map<string, Map<string, ResolvedManifestRoute>> {
  const byController = new Map<string, Map<string, ResolvedManifestRoute>>();
  if (!manifest) {
    return byController;
  }

  const register = (
    controller: string,
    handler: string,
    method: string,
    path: string,
  ): void => {
    let handlers = byController.get(controller);
    if (!handlers) {
      handlers = new Map();
      byController.set(controller, handlers);
    }
    if (!handlers.has(handler)) {
      handlers.set(handler, {
        method: method.toUpperCase(),
        path,
      });
    }
  };

  if (Array.isArray(manifest)) {
    for (const entry of manifest) {
      if (isRouteManifestEntry(entry) && entry.controller && entry.handler) {
        register(entry.controller, entry.handler, entry.method, entry.path);
      }
    }
    return byController;
  }

  for (const [key, value] of Object.entries(manifest)) {
    if (isRouteManifestEntry(value)) {
      if (value.controller && value.handler) {
        register(value.controller, value.handler, value.method, value.path);
      }
    } else if (typeof value === "object" && value !== null) {
      for (const [handlerName, nested] of Object.entries(value)) {
        if (isRouteManifestEntry(nested)) {
          register(
            nested.controller ?? key,
            nested.handler ?? handlerName,
            nested.method,
            nested.path,
          );
        }
      }
    }
  }

  return byController;
}

function normalizePathParams(
  params: Record<string, unknown> | undefined,
): Record<string, string | number> | undefined {
  if (!params) {
    return undefined;
  }
  const keys = Object.keys(params);
  if (keys.length === 0) {
    return undefined;
  }
  const normalized: Record<string, string | number> = {};
  for (const key of keys) {
    const raw = params[key];
    if (raw === undefined || raw === null) {
      normalized[key] = raw as unknown as string;
    } else if (typeof raw === "number" || typeof raw === "string") {
      normalized[key] = raw;
    } else {
      normalized[key] = String(raw);
    }
  }
  return normalized;
}

function resolveHttpClient(
  options: Pick<TypedClientOptions, "client"> & HttpClientOptions,
): HttpClient {
  if (options.client) {
    return options.client;
  }
  const { client: _ignored, ...httpOptions } = options;
  return new HttpClient(httpOptions);
}

function sendTypedRequest(
  http: HttpClient,
  method: string,
  path: string,
  options?: RawTypedCallOptions,
): Promise<HttpResponse<unknown>> {
  const effectiveMethod =
    method === "ALL"
      ? options?.body !== undefined
        ? "POST"
        : "GET"
      : method;

  if (!options) {
    return http.request(path, { method: effectiveMethod });
  }

  const { params, query, body, responseSchema, ...rest } = options;
  const reqOptions: HttpRequestOptions = {
    ...rest,
    method: effectiveMethod,
    params: normalizePathParams(params),
    query: query as HttpQuery | undefined,
    responseSchema,
  };

  if (body !== undefined) {
    if (isRawFetchBody(body)) {
      reqOptions.body = body;
    } else {
      reqOptions.json = body;
    }
  }

  return http.request(path, reqOptions);
}

function buildRpcProxy<TRoutes extends RouteRegistryLike>(
  http: HttpClient,
  manifest: RouteManifestLike | undefined,
): RpcClient<TRoutes> {
  const lookup = normalizeRouteManifest(manifest);
  const controllerCache = new Map<string, Record<string, unknown>>();

  const getControllerProxy = (controller: string): Record<string, unknown> => {
    const cached = controllerCache.get(controller);
    if (cached) {
      return cached;
    }
    const controllerProxy = new Proxy<Record<string, unknown>>(
      {},
      {
        get(_target, handlerProp) {
          if (
            typeof handlerProp !== "string" ||
            PROXY_PASSTHROUGH_KEYS.has(handlerProp)
          ) {
            return undefined;
          }
          return (callOptions?: RawTypedCallOptions) => {
            if (!manifest) {
              throw new Error(
                `TypedClient.$rpc.${controller}.${handlerProp}() requires a route \`manifest\` option ` +
                  "(e.g. `createTypedClient<AppRoutes>({ baseUrl, manifest: appRouteManifest })`). " +
                  "Generate one with `bunest typegen --client-types <output.ts>`.",
              );
            }
            const route = lookup.get(controller)?.get(handlerProp);
            if (!route) {
              const availableControllers = [...lookup.keys()];
              const hint =
                availableControllers.length > 0
                  ? ` Available controllers: ${availableControllers.join(", ")}.`
                  : " The provided route manifest contains no controller/handler entries.";
              throw new Error(
                `Unknown RPC route "${controller}.${handlerProp}": not found in route manifest.${hint}`,
              );
            }
            return sendTypedRequest(http, route.method, route.path, callOptions);
          };
        },
      },
    );
    controllerCache.set(controller, controllerProxy);
    return controllerProxy;
  };

  return new Proxy<Record<string, unknown>>(
    {},
    {
      get(_target, controllerProp) {
        if (
          typeof controllerProp !== "string" ||
          PROXY_PASSTHROUGH_KEYS.has(controllerProp)
        ) {
          return undefined;
        }
        return getControllerProxy(controllerProp);
      },
    },
  ) as unknown as RpcClient<TRoutes>;
}

/**
 * Creates a standalone typed RPC proxy (`client.<Controller>.<handler>(options)`)
 * backed by a route manifest and Bunest's zero-dependency `HttpClient`.
 *
 * Works in both browsers and Bun using standard `fetch`, `URL`, and `Headers`.
 */
export function createRpcClient<
  TRoutes extends RouteRegistryLike<TRoutes> = BunestRouteRegistry,
>(options: RpcClientOptions): RpcClient<TRoutes> {
  const { manifest, ...clientOptions } = options;
  const http = resolveHttpClient(clientOptions);
  return buildRpcProxy<TRoutes>(http, manifest);
}

/**
 * Creates an end-to-end type-safe HTTP & RPC client over a route registry
 * (`BunestRouteRegistry` from `.bunest/types/bunest.d.ts` or standalone
 * `AppRoutes` from `bunest typegen --client-types <output.ts>`).
 *
 * Works in both browsers and Bun using standard `fetch`, `URL`, and `Headers`.
 */
export function createTypedClient<
  TRoutes extends RouteRegistryLike<TRoutes> = BunestRouteRegistry,
>(options: TypedClientOptions = {}): TypedClient<TRoutes> {
  const { manifest, ...clientOptions } = options;
  const http = resolveHttpClient(clientOptions);
  const rpc = buildRpcProxy<TRoutes>(http, manifest);

  const makeVerb = <TMethod extends TypedClientHttpMethod>(
    method: TMethod,
  ): TypedHttpMethodFn<TRoutes, TMethod> =>
    ((path: string, callOptions?: RawTypedCallOptions) =>
      sendTypedRequest(
        http,
        method,
        path,
        callOptions,
      )) as TypedHttpMethodFn<TRoutes, TMethod>;

  return {
    get: makeVerb("GET"),
    post: makeVerb("POST"),
    put: makeVerb("PUT"),
    patch: makeVerb("PATCH"),
    delete: makeVerb("DELETE"),
    head: makeVerb("HEAD"),
    options: makeVerb("OPTIONS"),
    $rpc: rpc,
    http,
  };
}
