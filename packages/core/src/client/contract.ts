import type {
  StandardSchemaV1,
  StandardSchemaV1InferInput,
  StandardSchemaV1InferOutput,
} from "../common/interfaces/standard-schema.interface";
import { HttpClientValidationError } from "./errors/http-validation.error";
import { HttpClient } from "./http-client";
import type { HttpClientOptions } from "./interfaces/http-client-options.interface";
import type {
  HttpHeadersInit,
  HttpQuery,
  HttpRequestBody,
  HttpRequestOptions,
} from "./interfaces/http-request.interface";
import type { HttpResponse } from "./interfaces/http-response.interface";
import type {
  TypedClientHttpMethod,
  TypedRequestBaseOptions,
} from "./typed-client";
import { mergeHeaders } from "./utils/headers.util";

export const CONTRACT_ROUTE_MARKER = Symbol.for("bunest:contract:route");
export const CONTRACT_MARKER = Symbol.for("bunest:contract:definition");

/** HTTP methods supported by contract-first RPC/REST routes. */
export type ContractHttpMethod = TypedClientHttpMethod;

/**
 * Specification passed to `defineRoute(spec)` describing a single RPC/REST
 * contract route with optional Standard Schema v1 validators for `params`,
 * `query`, `body`, and `response`.
 */
export interface ContractRouteSpec<
  TMethod extends ContractHttpMethod = ContractHttpMethod,
  TPath extends string = string,
  TParamsSchema extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
  TQuerySchema extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
  TBodySchema extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
  TResponseSchema extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
> {
  readonly method: TMethod;
  readonly path: TPath;
  readonly params?: TParamsSchema;
  readonly query?: TQuerySchema;
  readonly body?: TBodySchema;
  readonly response?: TResponseSchema;
  readonly summary?: string;
  readonly description?: string;
  readonly headers?: HttpHeadersInit;
}

/**
 * Immutable runtime contract route returned by `defineRoute(spec)`.
 */
export interface ContractRoute<
  TMethod extends ContractHttpMethod = ContractHttpMethod,
  TPath extends string = string,
  TParamsSchema extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
  TQuerySchema extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
  TBodySchema extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
  TResponseSchema extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
> extends ContractRouteSpec<
    TMethod,
    TPath,
    TParamsSchema,
    TQuerySchema,
    TBodySchema,
    TResponseSchema
  > {
  readonly [CONTRACT_ROUTE_MARKER]: true;
}

/** Any `ContractRoute` regardless of concrete schema generics. */
export type AnyContractRoute = ContractRoute<
  ContractHttpMethod,
  string,
  StandardSchemaV1 | undefined,
  StandardSchemaV1 | undefined,
  StandardSchemaV1 | undefined,
  StandardSchemaV1 | undefined
>;

/** Recursive tree of named routes or nested sub-routers accepted by `defineContract()`. */
export interface ContractTree {
  readonly [key: string]: AnyContractRoute | ContractTree;
}

/** Options accepted by `defineContract(routes, options)`. */
export interface DefineContractOptions<TBasePath extends string = string> {
  /** Optional path prefix prepended to every route in the contract (e.g. `"/api/v1"`). */
  readonly basePath?: TBasePath;
  /** Optional default headers attached to every route in the contract. */
  readonly headers?: HttpHeadersInit;
}

type NormalizeJoinPath<
  TBase extends string,
  TPath extends string,
> = TBase extends "" | "/"
  ? TPath
  : TBase extends `${infer CleanBase}/`
    ? NormalizeJoinPath<CleanBase, TPath>
    : TPath extends "/"
      ? TBase
      : TPath extends `/${string}`
        ? `${TBase}${TPath}`
        : `${TBase}/${TPath}`;

type ApplyBasePathToTree<
  TRoutes extends ContractTree,
  TBasePath extends string | undefined,
> = [TBasePath] extends [string]
  ? string extends TBasePath
    ? TRoutes
    : {
        readonly [K in keyof TRoutes]: TRoutes[K] extends ContractRoute<
          infer M,
          infer P,
          infer PParams,
          infer PQuery,
          infer PBody,
          infer PRes
        >
          ? ContractRoute<
              M,
              NormalizeJoinPath<TBasePath, P>,
              PParams,
              PQuery,
              PBody,
              PRes
            >
          : TRoutes[K] extends ContractTree
            ? ApplyBasePathToTree<TRoutes[K], TBasePath>
            : TRoutes[K];
      }
  : TRoutes;

/** Contract tree tagged with `[CONTRACT_MARKER]`. */
export type ContractDefinition<TRoutes extends ContractTree = ContractTree> =
  TRoutes & {
    readonly [CONTRACT_MARKER]: true;
  };

/** Options accepted by `createContractClient(contract, options)`. */
export interface ContractClientOptions extends HttpClientOptions {
  /**
   * Optional pre-configured `HttpClient` instance. When omitted, a new browser-safe
   * `HttpClient` is created from the remaining options.
   */
  readonly client?: HttpClient | undefined;
  /**
   * Validate `params`, `query`, and `body` against the route's Standard Schemas
   * before sending the HTTP request.
   * @default true
   */
  readonly validateInput?: boolean | undefined;
  /**
   * Validate the parsed response payload against the route's `response` Standard
   * Schema (throwing `HttpClientValidationError` on failure).
   * @default true
   */
  readonly validateResponse?: boolean | undefined;
}

// ============================================================================
// Type-Level Inference Helpers
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

/** Infers the client-side `params` input type for a `ContractRoute`. */
export type InferContractRouteParams<TRoute> = TRoute extends ContractRoute<
  any,
  infer TPath,
  infer TParamsSchema,
  any,
  any,
  any
>
  ? TParamsSchema extends StandardSchemaV1
    ? StandardSchemaV1InferInput<TParamsSchema>
    : [ExtractPathParamNames<TPath>] extends [never]
      ? Record<string, never>
      : { readonly [K in ExtractPathParamNames<TPath>]: string | number }
  : Record<string, never>;

/** Infers the client-side `query` input type for a `ContractRoute`. */
export type InferContractRouteQuery<TRoute> = TRoute extends ContractRoute<
  any,
  any,
  any,
  infer TQuerySchema,
  any,
  any
>
  ? TQuerySchema extends StandardSchemaV1
    ? StandardSchemaV1InferInput<TQuerySchema>
    : Record<string, never>
  : Record<string, never>;

/** Infers the client-side `body` input type for a `ContractRoute`. */
export type InferContractRouteBody<TRoute> = TRoute extends ContractRoute<
  any,
  any,
  any,
  any,
  infer TBodySchema,
  any
>
  ? TBodySchema extends StandardSchemaV1
    ? StandardSchemaV1InferInput<TBodySchema>
    : undefined
  : undefined;

/** Infers the validated response payload output type for a `ContractRoute`. */
export type InferContractRouteResponse<TRoute> = TRoute extends ContractRoute<
  any,
  any,
  any,
  any,
  any,
  infer TResponseSchema
>
  ? TResponseSchema extends StandardSchemaV1
    ? StandardSchemaV1InferOutput<TResponseSchema>
    : unknown
  : unknown;

type ParamsField<TParams> = IsEmptyRecord<TParams> extends true
  ? { readonly params?: undefined }
  : HasRequiredKeys<TParams> extends true
    ? { readonly params: TParams }
    : { readonly params?: TParams | undefined };

type QueryField<TQuery> = IsEmptyRecord<TQuery> extends true
  ? { readonly query?: HttpQuery | undefined }
  : HasRequiredKeys<TQuery> extends true
    ? { readonly query: TQuery }
    : { readonly query?: TQuery | undefined };

type BodyField<TBody> = IsNoBody<TBody> extends true
  ? { readonly body?: undefined }
  : IsBodyRequired<TBody> extends true
    ? { readonly body: TBody }
    : { readonly body?: TBody | undefined };

type IsContractCallOptionsRequired<TRoute> =
  HasRequiredKeys<InferContractRouteParams<TRoute>> extends true
    ? true
    : HasRequiredKeys<InferContractRouteQuery<TRoute>> extends true
      ? true
      : IsBodyRequired<InferContractRouteBody<TRoute>>;

/** Per-call options accepted by a generated contract client method. */
export type ContractCallOptions<TRoute> = TypedRequestBaseOptions &
  ParamsField<InferContractRouteParams<TRoute>> &
  QueryField<InferContractRouteQuery<TRoute>> &
  BodyField<InferContractRouteBody<TRoute>>;

/** Optional or required tuple for a contract route method invocation. */
export type ContractCallArgs<TRoute> =
  IsContractCallOptionsRequired<TRoute> extends true
    ? [options: ContractCallOptions<TRoute>]
    : [options?: ContractCallOptions<TRoute>];

/** Callable typed RPC method generated for a single `ContractRoute`. */
export type ContractRouteInvoker<TRoute> = (
  ...args: ContractCallArgs<TRoute>
) => Promise<HttpResponse<InferContractRouteResponse<TRoute>>>;

/** Recursively mapped contract client matching the exact shape of `TRoutes`. */
export type ContractClient<TRoutes extends ContractTree> = {
  readonly [K in keyof TRoutes]: TRoutes[K] extends AnyContractRoute
    ? ContractRouteInvoker<TRoutes[K]>
    : TRoutes[K] extends ContractTree
      ? ContractClient<TRoutes[K]>
      : never;
} & {
  /** Underlying browser-safe `HttpClient` transport instance. */
  readonly $http: HttpClient;
};

// ============================================================================
// Runtime Implementation (100% Browser-Safe — Pure Web fetch / URL / Headers)
// ============================================================================

const VALID_METHODS = new Set<ContractHttpMethod>([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

function assertStandardSchema(
  schema: unknown,
  label: string,
): asserts schema is StandardSchemaV1 {
  if (schema === undefined) return;
  const std = (schema as Partial<StandardSchemaV1> | null | undefined)?.[
    "~standard"
  ];
  if (
    typeof std !== "object" ||
    std === null ||
    std.version !== 1 ||
    typeof std.validate !== "function"
  ) {
    throw new TypeError(
      `defineRoute() \`${label}\` must implement Standard Schema v1 (\`"~standard": { version: 1, validate }\`).`,
    );
  }
}

function joinContractPaths(basePath: string | undefined, path: string): string {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  if (!basePath || basePath === "/") {
    return cleanPath;
  }
  const cleanBase = `/${basePath.replace(/^\/+|\/+$/g, "")}`;
  if (cleanPath === "/") {
    return cleanBase;
  }
  return `${cleanBase}${cleanPath}`;
}

function isRawFetchBody(value: unknown): value is HttpRequestBody {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return true;
  if (typeof FormData !== "undefined" && value instanceof FormData) return true;
  if (
    typeof URLSearchParams !== "undefined" &&
    value instanceof URLSearchParams
  ) {
    return true;
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) return true;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true;
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

function normalizePathParams(
  params: unknown,
): Record<string, string | number> | undefined {
  if (typeof params !== "object" || params === null) {
    return undefined;
  }
  const rec = params as Record<string, unknown>;
  const keys = Object.keys(rec);
  if (keys.length === 0) {
    return undefined;
  }
  const normalized: Record<string, string | number> = {};
  for (const key of keys) {
    const raw = rec[key];
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

/**
 * Type guard checking whether `value` was created by `defineRoute()`.
 */
export function isContractRoute(value: unknown): value is AnyContractRoute {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[CONTRACT_ROUTE_MARKER] === true
  );
}

/**
 * Type guard checking whether `value` was created by `defineContract()`.
 */
export function isContractDefinition(
  value: unknown,
): value is ContractDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[CONTRACT_MARKER] === true
  );
}

/**
 * Defines a single zero-codegen contract-first RPC/REST route with optional
 * Standard Schema v1 validators for `params`, `query`, `body`, and `response`.
 */
export function defineRoute<
  const TMethod extends ContractHttpMethod,
  const TPath extends string,
  TParamsSchema extends StandardSchemaV1 | undefined = undefined,
  TQuerySchema extends StandardSchemaV1 | undefined = undefined,
  TBodySchema extends StandardSchemaV1 | undefined = undefined,
  TResponseSchema extends StandardSchemaV1 | undefined = undefined,
>(
  spec: ContractRouteSpec<
    TMethod,
    TPath,
    TParamsSchema,
    TQuerySchema,
    TBodySchema,
    TResponseSchema
  >,
): ContractRoute<
  TMethod,
  TPath,
  TParamsSchema,
  TQuerySchema,
  TBodySchema,
  TResponseSchema
> {
  if (!spec || typeof spec !== "object") {
    throw new TypeError("defineRoute() requires a route specification object.");
  }
  const normalizedMethod = String(spec.method ?? "").toUpperCase() as TMethod;
  if (!VALID_METHODS.has(normalizedMethod)) {
    throw new TypeError(
      `defineRoute() received unsupported HTTP method "${String(spec.method)}".`,
    );
  }
  if (typeof spec.path !== "string" || spec.path.trim().length === 0) {
    throw new TypeError("defineRoute() requires a non-empty string `path`.");
  }
  assertStandardSchema(spec.params, "params");
  assertStandardSchema(spec.query, "query");
  assertStandardSchema(spec.body, "body");
  assertStandardSchema(spec.response, "response");

  const route: ContractRoute<
    TMethod,
    TPath,
    TParamsSchema,
    TQuerySchema,
    TBodySchema,
    TResponseSchema
  > = {
    ...spec,
    method: normalizedMethod,
    path: (spec.path.startsWith("/") ? spec.path : `/${spec.path}`) as TPath,
    [CONTRACT_ROUTE_MARKER]: true,
  };

  return Object.freeze(route);
}

function normalizeContractTree(
  tree: ContractTree,
  options?: DefineContractOptions,
): ContractTree {
  const out: Record<string, AnyContractRoute | ContractTree> = {};
  for (const [key, value] of Object.entries(tree)) {
    if (isContractRoute(value)) {
      const mergedHeaders =
        options?.headers || value.headers
          ? mergeHeaders(new Headers(), options?.headers, value.headers)
          : undefined;
      out[key] = Object.freeze({
        ...value,
        path: joinContractPaths(options?.basePath, value.path),
        ...(mergedHeaders ? { headers: mergedHeaders } : {}),
        [CONTRACT_ROUTE_MARKER]: true as const,
      });
    } else if (typeof value === "object" && value !== null) {
      out[key] = normalizeContractTree(value as ContractTree, options);
    } else {
      throw new TypeError(
        `defineContract() entry "${key}" must be a ContractRoute (from defineRoute()) or nested route group.`,
      );
    }
  }
  return Object.freeze(out);
}

/**
 * Defines a shareable, zero-codegen RPC/REST contract tree usable on both
 * backend and browser/frontend clients without code generation.
 */
export function defineContract<
  const TRoutes extends ContractTree,
  const TBasePath extends string = "",
>(
  routes: TRoutes,
  options?: DefineContractOptions<TBasePath>,
): ContractDefinition<ApplyBasePathToTree<TRoutes, TBasePath>> {
  if (!routes || typeof routes !== "object" || Array.isArray(routes)) {
    throw new TypeError("defineContract() requires a route map object.");
  }
  const normalized = normalizeContractTree(routes, options) as Record<
    PropertyKey,
    unknown
  >;
  const clone: Record<PropertyKey, unknown> = { ...normalized };
  Object.defineProperty(clone, CONTRACT_MARKER, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(clone) as unknown as ContractDefinition<
    ApplyBasePathToTree<TRoutes, TBasePath>
  >;
}

async function validateInputField(
  schema: StandardSchemaV1,
  value: unknown,
  route: AnyContractRoute,
  partName: "params" | "query" | "body",
): Promise<unknown> {
  const result = await schema["~standard"].validate(value);
  if (result.issues) {
    throw new HttpClientValidationError({
      method: route.method,
      url: route.path,
      status: 0,
      statusText: `Client ${partName} validation failed`,
      headers: new Headers(),
      body: value,
      issues: result.issues,
    });
  }
  return result.value;
}

interface RawContractCallOptions extends TypedRequestBaseOptions {
  readonly params?: unknown;
  readonly query?: unknown;
  readonly body?: unknown;
}

function createRouteInvoker(
  route: AnyContractRoute,
  http: HttpClient,
  validateInput: boolean,
  validateResponse: boolean,
): (options?: RawContractCallOptions) => Promise<HttpResponse<unknown>> {
  return async (options?: RawContractCallOptions) => {
    let params = options?.params;
    let query = options?.query;
    let body = options?.body;

    if (validateInput) {
      if (route.params) {
        params = await validateInputField(
          route.params,
          params ?? {},
          route,
          "params",
        );
      }
      if (route.query) {
        query = await validateInputField(
          route.query,
          query ?? {},
          route,
          "query",
        );
      }
      if (route.body) {
        body = await validateInputField(route.body, body, route, "body");
      }
    }

    const {
      params: _p,
      query: _q,
      body: _b,
      headers: callHeaders,
      ...rest
    } = options ?? {};

    const mergedHeaders =
      route.headers || callHeaders
        ? mergeHeaders(new Headers(), route.headers, callHeaders)
        : undefined;

    const reqOptions: HttpRequestOptions = {
      ...rest,
      method: route.method,
      ...(mergedHeaders ? { headers: mergedHeaders } : {}),
      params: normalizePathParams(params),
      query: query as HttpQuery | undefined,
      ...(validateResponse && route.response
        ? { responseSchema: route.response }
        : {}),
    };

    if (body !== undefined) {
      if (isRawFetchBody(body)) {
        reqOptions.body = body;
      } else {
        reqOptions.json = body;
      }
    }

    return http.request(route.path, reqOptions);
  };
}

function buildContractNode(
  tree: ContractTree,
  http: HttpClient,
  validateInput: boolean,
  validateResponse: boolean,
): Record<string, unknown> {
  const node: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(tree)) {
    if (isContractRoute(entry)) {
      node[key] = createRouteInvoker(
        entry,
        http,
        validateInput,
        validateResponse,
      );
    } else if (typeof entry === "object" && entry !== null) {
      node[key] = buildContractNode(
        entry as ContractTree,
        http,
        validateInput,
        validateResponse,
      );
    }
  }
  return node;
}

/**
 * Creates a zero-codegen, 100% browser-safe typed RPC/REST client directly from
 * a `defineContract(...)` definition (using pure Web `fetch`, `URL`, `Headers`,
 * and optional Standard Schema v1 input/response validation).
 */
export function createContractClient<TRoutes extends ContractTree>(
  contract: TRoutes,
  options: ContractClientOptions = {},
): ContractClient<TRoutes> {
  if (!contract || typeof contract !== "object") {
    throw new TypeError(
      "createContractClient() requires a contract created with defineContract().",
    );
  }
  const {
    client,
    validateInput = true,
    validateResponse = true,
    ...httpOptions
  } = options;
  const http = client ?? new HttpClient(httpOptions);
  const root = buildContractNode(
    contract,
    http,
    validateInput,
    validateResponse,
  );
  if (!Object.prototype.hasOwnProperty.call(root, "$http")) {
    Object.defineProperty(root, "$http", {
      value: http,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
  return root as unknown as ContractClient<TRoutes>;
}
