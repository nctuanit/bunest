import {
  METADATA_KEYS,
  MetadataRegistry,
  RequestMethod,
  type BunestMiddleware,
  type ControllerMetadata,
  type HttpServer,
  type MiddlewareConsumer,
  type MiddlewareFunction,
  type MiddlewareProxy,
  type RouteInfo,
  type Type,
} from "../common/index";
import type { MiddlewareConfigEntry } from "../interfaces/core-types.interface";

export interface MiddlewareConfiguration<T = any> {
  middleware: T;
  forRoutes: Array<Type<any> | string | RouteInfo>;
  exclude?: RouteInfo[];
}

function normalizeRoutePath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "" || trimmed === "/") {
    return "/";
  }
  const withLeading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeading.length > 1 && withLeading.endsWith("/")
    ? withLeading.slice(0, -1)
    : withLeading;
}

function joinNormalizedPaths(...parts: string[]): string {
  const segments: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim().replace(/^\/+|\/+$/g, "");
    if (trimmed.length > 0) {
      segments.push(trimmed);
    }
  }
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

function toRouteInfos(
  entry: string | Type<unknown> | RouteInfo,
  controllerPrefixes?: ReadonlyMap<Type<unknown>, string[]>,
): RouteInfo[] {
  if (typeof entry === "string") {
    return [
      {
        path: normalizeRoutePath(entry),
        method: RequestMethod.ALL,
        _fromString: true,
      } as RouteInfo,
    ];
  }

  if (typeof entry === "function") {
    const routerPrefixes = controllerPrefixes?.get(entry);
    const effectivePrefixes =
      routerPrefixes && routerPrefixes.length > 0 ? routerPrefixes : [""];

    const precompiled = MetadataRegistry.getPrecompiledController(entry);
    if (precompiled && precompiled.routes.length > 0) {
      const infos: RouteInfo[] = [];
      const seen = new Set<string>();
      for (const routerPrefix of effectivePrefixes) {
        for (const ctrlPath of precompiled.paths) {
          for (const routeMeta of precompiled.routes) {
            const version =
              routeMeta.methodVersion ?? precompiled.controllerVersion;
            for (const methodPath of routeMeta.paths) {
              const path = joinNormalizedPaths(
                routerPrefix,
                ctrlPath,
                methodPath,
              );
              const method = routeMeta.method as RequestMethod;
              const versionKey = Array.isArray(version)
                ? version.map((v) => String(v)).join(",")
                : version !== undefined
                  ? String(version)
                  : "";
              const dedupKey = `${String(method)}:${path}:${versionKey}`;
              if (seen.has(dedupKey)) {
                continue;
              }
              seen.add(dedupKey);
              const info = {
                path,
                method,
                ...(version !== undefined ? { version } : {}),
              } as RouteInfo;
              infos.push(info);
            }
          }
        }
      }
      return infos;
    }

    const controllerMeta = MetadataRegistry.get<ControllerMetadata>(
      METADATA_KEYS.CONTROLLER,
      entry,
    );
    const rawPaths = controllerMeta
      ? Array.isArray(controllerMeta.path)
        ? controllerMeta.path
        : [controllerMeta.path]
      : ["/"];
    const ctrlVersion = controllerMeta?.version;

    const infos: RouteInfo[] = [];
    for (const routerPrefix of effectivePrefixes) {
      for (const p of rawPaths) {
        const normalized = joinNormalizedPaths(routerPrefix, p);
        infos.push({
          path: normalized,
          method: RequestMethod.ALL,
          ...(ctrlVersion !== undefined ? { version: ctrlVersion } : {}),
        } as RouteInfo);
        const wildcard = normalized === "/" ? "/*" : `${normalized}/*`;
        infos.push({
          path: wildcard,
          method: RequestMethod.ALL,
          ...(ctrlVersion !== undefined ? { version: ctrlVersion } : {}),
        } as RouteInfo);
      }
    }
    return infos;
  }

  const version = (entry as RouteInfo & { version?: unknown }).version;
  return [
    {
      path: normalizeRoutePath(entry.path),
      method: entry.method,
      ...(version !== undefined ? { version } : {}),
    } as RouteInfo,
  ];
}

class CoreMiddlewareProxy implements MiddlewareProxy {
  private readonly excluded: RouteInfo[] = [];

  constructor(
    private readonly consumer: CoreMiddlewareConsumer,
    private readonly middlewares: ReadonlyArray<
      Type<BunestMiddleware> | MiddlewareFunction
    >,
  ) {}

  exclude(...routes: Array<string | RouteInfo>): MiddlewareProxy {
    for (const route of routes) {
      this.excluded.push(
        ...toRouteInfos(route, this.consumer.getControllerPrefixes()),
      );
    }
    return this;
  }

  forRoutes(
    ...routes: Array<string | Type<unknown> | RouteInfo>
  ): MiddlewareConsumer {
    const included: RouteInfo[] = [];
    for (const route of routes) {
      included.push(
        ...toRouteInfos(route, this.consumer.getControllerPrefixes()),
      );
    }

    for (const middleware of this.middlewares) {
      this.consumer.addEntry({
        middleware,
        include: included.length > 0 ? included : undefined,
        exclude: this.excluded.length > 0 ? [...this.excluded] : undefined,
        moduleId: this.consumer.moduleId,
      });
    }

    return this.consumer;
  }
}

/**
 * Collects module-level middleware registrations from `BunestModule.configure(consumer)`,
 * implementing both `MiddlewareConsumer` and NestJS `MiddlewareBuilder` (`build`,
 * `getHttpAdapter`, `getServedRoutes`).
 */
export class CoreMiddlewareConsumer implements MiddlewareConsumer {
  private readonly entries: MiddlewareConfigEntry[] = [];

  constructor(
    public readonly moduleId: string = "default",
    private readonly httpAdapter?: HttpServer,
    private readonly servedRoutes?: RouteInfo[],
    private readonly controllerPrefixes?: ReadonlyMap<Type<unknown>, string[]>,
  ) {}

  getControllerPrefixes(): ReadonlyMap<Type<unknown>, string[]> | undefined {
    return this.controllerPrefixes;
  }

  apply(
    ...middleware: Array<
      | Type<BunestMiddleware>
      | MiddlewareFunction
      | Array<Type<BunestMiddleware> | MiddlewareFunction>
    >
  ): MiddlewareProxy {
    const flattened = middleware.flat() as Array<
      Type<BunestMiddleware> | MiddlewareFunction
    >;
    return new CoreMiddlewareProxy(this, flattened);
  }

  addEntry(entry: MiddlewareConfigEntry): void {
    this.entries.push(entry);
  }

  getConfigs(): MiddlewareConfigEntry[] {
    return [...this.entries];
  }

  /**
   * Builds NestJS-compatible `MiddlewareConfiguration[]` entries from all registered middleware.
   */
  build(): MiddlewareConfiguration[] {
    return this.entries.map((entry) => ({
      middleware: entry.middleware,
      forRoutes: entry.include ? [...entry.include] : [],
      ...(entry.exclude && entry.exclude.length > 0
        ? { exclude: [...entry.exclude] }
        : {}),
    }));
  }

  /**
   * Returns the bound `HttpServer` adapter, if supplied.
   */
  getHttpAdapter(): HttpServer {
    return this.httpAdapter as HttpServer;
  }

  /**
   * Returns the list of routes served by controllers (or matched by registered middleware).
   */
  getServedRoutes(): RouteInfo[] {
    if (this.servedRoutes) {
      return [...this.servedRoutes];
    }
    const collected: RouteInfo[] = [];
    const seen = new Set<string>();
    for (const entry of this.entries) {
      if (!entry.include) continue;
      for (const route of entry.include) {
        const key = `${String(route.method)}:${route.path}`;
        if (!seen.has(key)) {
          seen.add(key);
          collected.push(route);
        }
      }
    }
    return collected;
  }
}
