/**
 * registries.interface.ts
 *
 * Global Module Augmentation registries for `@bunest/core` (re-exported by `@bunest/core`).
 * Automatically augmented by `bunest typegen` and `bunest dev` (powered by `ts-morph`).
 */

import type { RouteHttpMethod } from "../enums/scope.enum";

/**
 * Shape of a single route entry in `BunestRouteRegistry`.
 */
export interface RegisteredRouteDefinition {
  readonly method: RouteHttpMethod;
  readonly path: string;
  readonly params: Record<string, string | number>;
  readonly query: Record<string, unknown>;
  readonly body: unknown;
  readonly response: unknown;
  readonly controller?: string;
  readonly handler?: string;
}

/**
 * Global registry of HTTP routes discovered across all `@Controller()` classes.
 * Key format: `"GET /users/:id"`, `"POST /users"`, etc.
 *
 * Automatically augmented in `.bunest/types/bunest.d.ts` by `bunest dev` / `bunest typegen`.
 */
export interface BunestRouteRegistry {}

/**
 * Global registry of string DI provider tokens (`provide: "TOKEN"` / `createToken<T>(...)`)
 * mapping token names to their resolved runtime service/value types.
 *
 * Automatically augmented in `.bunest/types/bunest.d.ts` by `bunest dev` / `bunest typegen`.
 */
export interface BunestTokenRegistry {}

/** Union of all registered route keys (e.g. `"GET /users" | "POST /users"`). */
export type BunestRouteKey = keyof BunestRouteRegistry & string;

/** Union of all registered route paths, optionally filtered by HTTP method. */
export type BunestRoutePath<M extends RouteHttpMethod = RouteHttpMethod> = [
  keyof BunestRouteRegistry,
] extends [never]
  ? string
  : {
      [K in keyof BunestRouteRegistry]: BunestRouteRegistry[K] extends {
        method: infer RM;
        path: infer RP extends string;
      }
        ? RM extends M | "ALL"
          ? RP
          : never
        : never;
    }[keyof BunestRouteRegistry];

/** Autocomplete-friendly route path input (preserves support for concrete IDs/query strings). */
export type RoutePathInput<M extends RouteHttpMethod = RouteHttpMethod> = [
  keyof BunestRouteRegistry,
] extends [never]
  ? string
  : BunestRoutePath<M> | (string & {});

/** Look up route entry metadata by HTTP method and path template. */
export type BunestRouteEntry<
  M extends RouteHttpMethod,
  P extends string,
> = `${M} ${P}` extends keyof BunestRouteRegistry
  ? BunestRouteRegistry[`${M} ${P}`]
  : never;

/** Extract response type for a registered route (`"GET"`, `"/users/:id"`). */
export type BunestRouteResponse<M extends RouteHttpMethod, P extends string> =
  BunestRouteEntry<M, P> extends { response: infer R } ? R : unknown;

/** Extract request body type for a registered route. */
export type BunestRouteBody<M extends RouteHttpMethod, P extends string> =
  BunestRouteEntry<M, P> extends { body: infer B } ? B : unknown;

/** Extract path params type for a registered route. */
export type BunestRouteParams<M extends RouteHttpMethod, P extends string> =
  BunestRouteEntry<M, P> extends { params: infer Params }
    ? Params
    : Record<string, string | number>;

/** Extract query params type for a registered route. */
export type BunestRouteQuery<M extends RouteHttpMethod, P extends string> =
  BunestRouteEntry<M, P> extends { query: infer Q }
    ? Q
    : Record<string, unknown>;

/** Extract `:param` parameter names directly from a route template string. */
export type ExtractRouteParamNames<TPath extends string> =
  TPath extends `${string}:${infer Param}/${infer Rest}`
    ? Param | ExtractRouteParamNames<Rest>
    : TPath extends `${string}:${infer Param}`
      ? Param
      : never;

/** Object of required path parameter values for a route template `TPath`. */
export type RouteParamsForPath<TPath extends string> = [
  ExtractRouteParamNames<TPath>,
] extends [never]
  ? Record<string, never>
  : { [K in ExtractRouteParamNames<TPath>]: string | number };

/** Union of all registered DI token names (or `never` when unaugmented). */
export type RegisteredTokenName = keyof BunestTokenRegistry & string;

/**
 * Type-safe route URL builder. Interpolates `:param` segments with full IDE
 * autocomplete on discovered controller routes and required path parameters.
 *
 * @example
 * ```ts
 * const url = buildRoutePath("/users/:id", { id: 42 }); // "/users/42"
 * ```
 */
export function buildRoutePath<TPath extends RoutePathInput>(
  template: TPath,
  ...args: [ExtractRouteParamNames<TPath>] extends [never]
    ? [params?: Record<string, string | number>]
    : [params: RouteParamsForPath<TPath>]
): string {
  const params = args[0] as Record<string, string | number> | undefined;
  if (!params) {
    return template;
  }
  return template.replace(/:([A-Za-z0-9_]+)/g, (_match, key: string) => {
    const val = params[key];
    if (val === undefined) {
      throw new Error(
        `Missing required route parameter ":${key}" for template "${template}".`,
      );
    }
    return encodeURIComponent(String(val));
  });
}
