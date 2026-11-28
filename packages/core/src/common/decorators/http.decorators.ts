import { METADATA_KEYS } from "../constants/metadata-keys";
import { RequestMethod, type RouteHttpMethod } from "../enums/scope.enum";
import type {
  ControllerMetadata,
  ControllerOptions,
  HeaderMetadata,
  RedirectMetadata,
  RequestMappingMetadata,
  RouteMethodMetadata,
  SseOptions,
} from "../interfaces/http.interface";
import { DecoratorRegistry } from "../metadata/decorator-registry";
import { MetadataRegistry } from "../metadata/metadata-registry";
import { ternaryFor } from "../utils/ternary.util";
import { isArray } from "../utils/type-guards.util";
import { attachAutoLogger } from "./core.decorators";

/**
 * Declares a controller class and its optional route path prefix / host / scope,
 * self-registering it into `DecoratorRegistry` and pre-indexing its route/enhancer
 * descriptor at class-evaluation time.
 */
export function Controller(
  prefixOrOptions?: string | string[] | ControllerOptions,
): ClassDecorator {
  return (target: Function) => {
    let metadata: ControllerMetadata;

    if (prefixOrOptions === undefined) {
      metadata = { path: "/" };
    } else if (
      typeof prefixOrOptions === "string" ||
      Array.isArray(prefixOrOptions)
    ) {
      metadata = {
        path: Array.isArray(prefixOrOptions)
          ? [...prefixOrOptions]
          : prefixOrOptions,
      };
    } else {
      const clonedVersion = Array.isArray(prefixOrOptions.version)
        ? [...new Set(prefixOrOptions.version)]
        : prefixOrOptions.version;
      metadata = {
        path: Array.isArray(prefixOrOptions.path)
          ? [...prefixOrOptions.path]
          : (prefixOrOptions.path ?? "/"),
        ...(prefixOrOptions.host !== undefined
          ? { host: prefixOrOptions.host }
          : {}),
        ...(prefixOrOptions.scope !== undefined
          ? { scope: prefixOrOptions.scope }
          : {}),
        ...(clonedVersion !== undefined ? { version: clonedVersion } : {}),
        ...(prefixOrOptions.durable !== undefined
          ? { durable: prefixOrOptions.durable }
          : {}),
      };
      if (
        clonedVersion !== undefined &&
        !MetadataRegistry.hasOwn(METADATA_KEYS.VERSION, target)
      ) {
        MetadataRegistry.define(METADATA_KEYS.VERSION, clonedVersion, target);
      }
    }

    MetadataRegistry.define<ControllerMetadata>(
      METADATA_KEYS.CONTROLLER,
      metadata,
      target,
    );
    DecoratorRegistry.registerController(target, metadata);
    MetadataRegistry.precompileController(target);
    attachAutoLogger(target, "Controller");
  };
}

function registerRouteMetadata(
  method: RouteHttpMethod,
  path: string | string[],
  isSse = false,
  sseOptions?: SseOptions,
): MethodDecorator {
  return (
    target: object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) => {
    const normalizedPath = ternaryFor(path)
      .when(isArray, (p) => (p.length === 0 ? "/" : [...p]))
      .elseEval((p) => (isSse && p === "" ? "/" : p));
    const entry: RouteMethodMetadata = isSse
      ? {
          method,
          path: normalizedPath,
          handlerKey: propertyKey,
          isSse: true,
          ...(sseOptions ? { sseOptions: { ...sseOptions } } : {}),
        }
      : { method, path: normalizedPath, handlerKey: propertyKey };

    // Copy-on-write own array on target.constructor so subclasses NEVER mutate parent routes.
    // Insert before first existing route for the same handlerKey to preserve top-to-bottom
    // order when route decorators are stacked on one method, while preserving method order across methods.
    const existing =
      MetadataRegistry.getOwn<readonly RouteMethodMetadata[]>(
        METADATA_KEYS.ROUTES,
        target.constructor,
      ) ?? [];
    const firstSameHandlerIdx = existing.findIndex(
      (route) => route.handlerKey === propertyKey,
    );
    const nextRoutes =
      firstSameHandlerIdx !== -1
        ? [
            ...existing.slice(0, firstSameHandlerIdx),
            entry,
            ...existing.slice(firstSameHandlerIdx),
          ]
        : [...existing, entry];

    MetadataRegistry.define(
      METADATA_KEYS.ROUTES,
      nextRoutes,
      target.constructor,
    );

    if (descriptor && descriptor.value !== undefined) {
      MetadataRegistry.define(
        METADATA_KEYS.ROUTE_METHOD,
        method,
        descriptor.value,
      );
      MetadataRegistry.define(
        METADATA_KEYS.ROUTE_PATH,
        normalizedPath,
        descriptor.value,
      );
      if (isSse) {
        MetadataRegistry.define(METADATA_KEYS.SSE, true, descriptor.value);
        if (sseOptions) {
          MetadataRegistry.define(
            METADATA_KEYS.SSE_OPTIONS,
            { ...sseOptions },
            descriptor.value,
          );
        }
      }
    }

    return descriptor;
  };
}

function createRouteDecorator(
  method: RouteHttpMethod,
): (path?: string | string[]) => MethodDecorator {
  return (path: string | string[] = ""): MethodDecorator =>
    registerRouteMetadata(method, path, false);
}

/**
 * Low-level HTTP route decorator matching NestJS `@RequestMapping()`.
 */
export function RequestMapping(
  metadata: RequestMappingMetadata = {},
): MethodDecorator {
  const path = metadata.path ?? "/";
  const method = (metadata.method ?? RequestMethod.GET) as RouteHttpMethod;
  return registerRouteMetadata(method, path, false);
}

export const Get = createRouteDecorator("GET");
export const Post = createRouteDecorator("POST");
export const Put = createRouteDecorator("PUT");
export const Patch = createRouteDecorator("PATCH");
export const Delete = createRouteDecorator("DELETE");
export const Options = createRouteDecorator("OPTIONS");
export const Head = createRouteDecorator("HEAD");
export const All = createRouteDecorator("ALL");
export const Search = createRouteDecorator("SEARCH");
export const Propfind = createRouteDecorator("PROPFIND");
export const Proppatch = createRouteDecorator("PROPPATCH");
export const Mkcol = createRouteDecorator("MKCOL");
export const Copy = createRouteDecorator("COPY");
export const Move = createRouteDecorator("MOVE");
export const Lock = createRouteDecorator("LOCK");
export const Unlock = createRouteDecorator("UNLOCK");
export const QueryMethod = createRouteDecorator("QUERY");

/**
 * Declares a Server-Sent Events route handler (supports NestJS v12 `SseOptions`
 * including custom `method` and `maxPendingDataLength` backpressure limit).
 */
export function Sse(
  path: string | string[] = "",
  options?: SseOptions,
): MethodDecorator {
  const method = (options?.method ?? RequestMethod.GET) as RouteHttpMethod;
  return registerRouteMetadata(method, path, true, options);
}

/**
 * Declares a view template name to render using the application's configured view engine
 * (`app.setViewEngine(...)`).
 */
export function Render(template: string): MethodDecorator {
  return (
    _target: object,
    _propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) => {
    MetadataRegistry.define<string>(
      METADATA_KEYS.RENDER,
      template,
      descriptor.value,
    );
    return descriptor;
  };
}

/**
 * Overrides the default HTTP response status code for a route handler.
 */
export function HttpCode(statusCode: number): MethodDecorator {
  return (
    _target: object,
    _propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) => {
    MetadataRegistry.define<number>(
      METADATA_KEYS.HTTP_CODE,
      statusCode,
      descriptor.value,
    );
    return descriptor;
  };
}

/**
 * Sets a static response header on a route handler.
 * Stacked @Header() decorators accumulate in top-to-bottom declaration order without mutating parent metadata.
 */
export function Header(name: string, value: string): MethodDecorator {
  return (
    _target: object,
    _propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) => {
    MetadataRegistry.prependOwnArray<HeaderMetadata>(
      METADATA_KEYS.HEADERS,
      [{ name, value }],
      descriptor.value,
    );
    return descriptor;
  };
}

/**
 * Configures an HTTP redirect response for a route handler.
 */
export function Redirect(url = "", statusCode = 302): MethodDecorator {
  return (
    _target: object,
    _propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) => {
    MetadataRegistry.define<RedirectMetadata>(
      METADATA_KEYS.REDIRECT,
      { url, statusCode },
      descriptor.value,
    );
    return descriptor;
  };
}
