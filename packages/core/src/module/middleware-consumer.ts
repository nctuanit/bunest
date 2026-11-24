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

function toRouteInfos(entry: string | Type<unknown> | RouteInfo): RouteInfo[] {
  if (typeof entry === "string") {
    return [{ path: normalizeRoutePath(entry), method: RequestMethod.ALL }];
  }

  if (typeof entry === "function") {
    const controllerMeta = MetadataRegistry.get<ControllerMetadata>(
      METADATA_KEYS.CONTROLLER,
      entry,
    );
    const rawPaths = controllerMeta
      ? Array.isArray(controllerMeta.path)
        ? controllerMeta.path
        : [controllerMeta.path]
      : ["/"];

    const infos: RouteInfo[] = [];
    for (const p of rawPaths) {
      const normalized = normalizeRoutePath(p);
      infos.push({ path: normalized, method: RequestMethod.ALL });
      const wildcard = normalized === "/" ? "/*" : `${normalized}/*`;
      infos.push({ path: wildcard, method: RequestMethod.ALL });
    }
    return infos;
  }

  return [
    {
      path: normalizeRoutePath(entry.path),
      method: entry.method,
    },
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
      this.excluded.push(...toRouteInfos(route));
    }
    return this;
  }

  forRoutes(
    ...routes: Array<string | Type<unknown> | RouteInfo>
  ): MiddlewareConsumer {
    const included: RouteInfo[] = [];
    for (const route of routes) {
      included.push(...toRouteInfos(route));
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
  ) {}

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
