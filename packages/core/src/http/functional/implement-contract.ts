import {
  CONTRACT_MARKER,
  isContractRoute,
  type AnyContractRoute,
  type ContractRoute,
  type ContractTree,
} from "../../client/contract";
import type {
  ExceptionFilterLike,
  GuardLike,
  InterceptorLike,
  PipeLike,
  StandardSchemaV1,
  StandardSchemaV1InferInput,
  StandardSchemaV1InferOutput,
  VersionValue,
} from "../../common/index";
import {
  defineRoutes,
  type FunctionalRouteContext,
  type FunctionalRouteGroup,
  type FunctionalRouteGroupOptions,
} from "./define-routes";

type ExtractContractPathParamNames<TPath extends string> =
  TPath extends `${string}/:${infer Param}/${infer Rest}`
    ? Param | ExtractContractPathParamNames<`/${Rest}`>
    : TPath extends `${string}/:${infer Param}`
      ? Param
      : TPath extends `:${infer Param}/${infer Rest}`
        ? Param | ExtractContractPathParamNames<`/${Rest}`>
        : TPath extends `:${infer Param}`
          ? Param
          : never;

/** Server-side validated `params` type inferred for a `ContractRoute`. */
export type InferContractServerParams<TRoute> = TRoute extends ContractRoute<
  any,
  infer TPath,
  infer TParamsSchema,
  any,
  any,
  any
>
  ? TParamsSchema extends StandardSchemaV1
    ? StandardSchemaV1InferOutput<TParamsSchema>
    : [ExtractContractPathParamNames<TPath>] extends [never]
      ? Record<string, string>
      : { readonly [K in ExtractContractPathParamNames<TPath>]: string }
  : Record<string, string>;

/** Server-side validated `query` type inferred for a `ContractRoute`. */
export type InferContractServerQuery<TRoute> = TRoute extends ContractRoute<
  any,
  any,
  any,
  infer TQuerySchema,
  any,
  any
>
  ? TQuerySchema extends StandardSchemaV1
    ? StandardSchemaV1InferOutput<TQuerySchema>
    : Record<string, string | string[]>
  : Record<string, string | string[]>;

/** Server-side validated `body` type inferred for a `ContractRoute`. */
export type InferContractServerBody<TRoute> = TRoute extends ContractRoute<
  any,
  any,
  any,
  any,
  infer TBodySchema,
  any
>
  ? TBodySchema extends StandardSchemaV1
    ? StandardSchemaV1InferOutput<TBodySchema>
    : unknown
  : unknown;

/** Server-side handler return type inferred for a `ContractRoute`. */
export type InferContractServerResponse<TRoute> = TRoute extends ContractRoute<
  any,
  any,
  any,
  any,
  any,
  infer TResponseSchema
>
  ? TResponseSchema extends StandardSchemaV1
    ?
        | StandardSchemaV1InferInput<TResponseSchema>
        | StandardSchemaV1InferOutput<TResponseSchema>
    : unknown
  : unknown;

/** Server handler function matching a single `ContractRoute`. */
export type ContractRouteHandler<TRoute extends AnyContractRoute> = (
  ctx: FunctionalRouteContext<
    InferContractServerParams<TRoute>,
    InferContractServerQuery<TRoute>,
    InferContractServerBody<TRoute>
  >,
) =>
  | InferContractServerResponse<TRoute>
  | Response
  | Promise<InferContractServerResponse<TRoute> | Response>;

/** Per-route configuration object allowing guards/pipes/interceptors/filters alongside `handler`. */
export interface ContractRouteHandlerConfig<TRoute extends AnyContractRoute> {
  readonly guards?: readonly GuardLike[];
  readonly pipes?: readonly PipeLike[];
  readonly interceptors?: readonly InterceptorLike[];
  readonly filters?: readonly ExceptionFilterLike[];
  readonly httpCode?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly version?: VersionValue;
  readonly summary?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly operationId?: string;
  readonly deprecated?: boolean;
  readonly handler: ContractRouteHandler<TRoute>;
}

/** Either a direct handler function or a route config object `{ guards, ..., handler }`. */
export type ContractRouteImplementation<TRoute extends AnyContractRoute> =
  | ContractRouteHandler<TRoute>
  | ContractRouteHandlerConfig<TRoute>;

/** Recursive handler map matching every route in a `defineContract()` tree. */
export type ContractHandlers<TRoutes extends ContractTree> = {
  readonly [K in Exclude<keyof TRoutes, typeof CONTRACT_MARKER>]: TRoutes[K] extends AnyContractRoute
    ? ContractRouteImplementation<TRoutes[K]>
    : TRoutes[K] extends ContractTree
      ? ContractHandlers<TRoutes[K]>
      : never;
};

/** Optional shared enhancers and metadata applied to every implemented contract route. */
export interface ImplementContractOptions
  extends Omit<FunctionalRouteGroupOptions, "prefix"> {
  /** Optional default OpenAPI tag for top-level contract routes (sub-routers default to their group key). */
  readonly defaultTag?: string;
}

interface CollectedContractRoute {
  readonly groupKey: string | undefined;
  readonly operationId: string;
  readonly route: AnyContractRoute;
  readonly implementation: ContractRouteImplementation<AnyContractRoute>;
}

function isHandlerConfig(
  value: unknown,
): value is ContractRouteHandlerConfig<AnyContractRoute> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { handler?: unknown }).handler === "function"
  );
}

function collectContractImplementations(
  contractNode: ContractTree,
  handlersNode: Record<string, unknown>,
  pathSegments: readonly string[],
  collected: CollectedContractRoute[],
): void {
  for (const [key, entry] of Object.entries(contractNode)) {
    const nextSegments = [...pathSegments, key];
    const dottedPath = nextSegments.join(".");
    const handlerEntry = handlersNode[key];

    if (isContractRoute(entry)) {
      if (
        typeof handlerEntry !== "function" &&
        !isHandlerConfig(handlerEntry)
      ) {
        throw new TypeError(
          `implementContract() is missing a handler function or { handler } object for contract route "${dottedPath}" (${entry.method} ${entry.path}).`,
        );
      }
      collected.push({
        groupKey: pathSegments.length > 0 ? pathSegments[0] : undefined,
        operationId: dottedPath,
        route: entry,
        implementation:
          handlerEntry as ContractRouteImplementation<AnyContractRoute>,
      });
    } else if (typeof entry === "object" && entry !== null) {
      if (
        typeof handlerEntry !== "object" ||
        handlerEntry === null ||
        Array.isArray(handlerEntry)
      ) {
        throw new TypeError(
          `implementContract() is missing handler group "${dottedPath}".`,
        );
      }
      collectContractImplementations(
        entry as ContractTree,
        handlerEntry as Record<string, unknown>,
        nextSegments,
        collected,
      );
    }
  }
}

/**
 * Compiles a shared `defineContract()` tree + type-checked server `handlers`
 * into `FunctionalRouteGroup[]` that execute inside Bunest's native 11-stage
 * HTTP pipeline with full DI, Standard Schema input/response validation, and
 * automatic OpenAPI 3.1 Swagger documentation.
 */
export function implementContract<TRoutes extends ContractTree>(
  contract: TRoutes,
  handlers: ContractHandlers<TRoutes>,
  options: ImplementContractOptions = {},
): readonly FunctionalRouteGroup[] {
  if (!contract || typeof contract !== "object") {
    throw new TypeError(
      "implementContract() requires a contract created with defineContract().",
    );
  }
  if (!handlers || typeof handlers !== "object" || Array.isArray(handlers)) {
    throw new TypeError(
      "implementContract() requires a handlers object matching the contract tree.",
    );
  }

  const collected: CollectedContractRoute[] = [];
  collectContractImplementations(
    contract,
    handlers as unknown as Record<string, unknown>,
    [],
    collected,
  );

  // Partition routes by top-level contract group so OpenAPI tags group cleanly
  const grouped = new Map<string, CollectedContractRoute[]>();
  for (const item of collected) {
    const bucketKey = item.groupKey ?? options.defaultTag ?? "default";
    const list = grouped.get(bucketKey);
    if (list) {
      list.push(item);
    } else {
      grouped.set(bucketKey, [item]);
    }
  }

  const { defaultTag: _defaultTag, tags: explicitGroupTags, ...sharedGroupOpts } =
    options;
  const routeGroups: FunctionalRouteGroup[] = [];

  for (const [bucketKey, items] of grouped.entries()) {
    const groupTags =
      explicitGroupTags && explicitGroupTags.length > 0
        ? explicitGroupTags
        : [bucketKey];

    const group = defineRoutes(
      {
        ...sharedGroupOpts,
        prefix: "",
        tags: groupTags,
      },
      (r) => {
        for (const item of items) {
          const { route, implementation, operationId } = item;
          const cfg = isHandlerConfig(implementation)
            ? implementation
            : undefined;
          const handlerFn = cfg ? cfg.handler : (implementation as ContractRouteHandler<AnyContractRoute>);

          r.route(
            route.method,
            route.path,
            {
              ...(route.params !== undefined
                ? { paramsSchema: route.params }
                : {}),
              ...(route.query !== undefined
                ? { querySchema: route.query }
                : {}),
              ...(route.body !== undefined ? { bodySchema: route.body } : {}),
              ...(route.response !== undefined
                ? { responseSchema: route.response }
                : {}),
              parseBody: route.body !== undefined,
              ...(cfg?.guards ? { guards: cfg.guards } : {}),
              ...(cfg?.pipes ? { pipes: cfg.pipes } : {}),
              ...(cfg?.interceptors ? { interceptors: cfg.interceptors } : {}),
              ...(cfg?.filters ? { filters: cfg.filters } : {}),
              ...(cfg?.httpCode !== undefined ? { httpCode: cfg.httpCode } : {}),
              ...(cfg?.headers ? { headers: cfg.headers } : {}),
              ...(cfg?.version !== undefined ? { version: cfg.version } : {}),
              summary: cfg?.summary ?? route.summary,
              description: cfg?.description ?? route.description,
              operationId: cfg?.operationId ?? operationId,
              ...(cfg?.deprecated !== undefined
                ? { deprecated: cfg.deprecated }
                : {}),
              ...(cfg?.tags ? { tags: cfg.tags } : {}),
            },
            handlerFn,
          );
        }
      },
    );

    routeGroups.push(group);
  }

  return Object.freeze(routeGroups);
}
