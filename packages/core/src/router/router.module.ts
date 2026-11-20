import {
  Module,
  type DynamicModule,
  type Type,
} from "@bunest/common";
import type { ScannedModuleGraph } from "../module/module-scanner";

export const ROUTER_MODULE_ROUTES = Symbol.for(
  "bunest:core:router_module_routes",
);

export interface RouteTree {
  path: string;
  module?: Type<unknown>;
  children?: Routes;
}

export type Routes = Array<RouteTree | Type<unknown>>;

/**
 * Joins one or more route path segments cleanly into a normalized slash-prefixed path.
 */
export function joinRoutePaths(...segments: readonly string[]): string {
  const parts: string[] = [];
  for (const segment of segments) {
    const trimmed = segment.trim().replace(/^\/+|\/+$/g, "");
    if (trimmed.length > 0) {
      parts.push(trimmed);
    }
  }
  return parts.length > 0 ? `/${parts.join("/")}` : "/";
}

/**
 * Flattens an arbitrarily nested `Routes` tree into a map from module class to
 * its resolved full path prefix(es).
 */
export function flattenRouteTree(
  routes: Routes,
  parentPrefix = "",
  acc = new Map<Type<unknown>, string[]>(),
): Map<Type<unknown>, string[]> {
  for (const entry of routes) {
    if (typeof entry === "function") {
      const normalized = joinRoutePaths(parentPrefix);
      const list = acc.get(entry) ?? [];
      if (!list.includes(normalized)) {
        list.push(normalized);
      }
      acc.set(entry, list);
      continue;
    }

    const combined = joinRoutePaths(parentPrefix, entry.path);
    if (entry.module) {
      const list = acc.get(entry.module) ?? [];
      if (!list.includes(combined)) {
        list.push(combined);
      }
      acc.set(entry.module, list);
    }

    if (entry.children && entry.children.length > 0) {
      flattenRouteTree(entry.children, combined, acc);
    }
  }

  return acc;
}

/**
 * Collects all `RouterModule.register(...)` definitions in the scanned module
 * graph and resolves full path prefixes per controller class.
 */
export function resolveRouterModulePrefixes(
  graph: ScannedModuleGraph,
): Map<Type<unknown>, string[]> {
  const modulePrefixes = new Map<Type<unknown>, string[]>();

  for (const mod of graph.topologicalOrder) {
    const routeProvider = mod.providers.get(ROUTER_MODULE_ROUTES);
    if (routeProvider && routeProvider.kind === "value") {
      const rawRoutes = routeProvider.useValue;
      if (Array.isArray(rawRoutes)) {
        flattenRouteTree(rawRoutes as Routes, "", modulePrefixes);
      }
    }
  }

  const controllerPrefixes = new Map<Type<unknown>, string[]>();
  if (modulePrefixes.size === 0) {
    return controllerPrefixes;
  }

  for (const mod of graph.topologicalOrder) {
    const prefixes = modulePrefixes.get(mod.metatype);
    if (!prefixes || prefixes.length === 0) {
      continue;
    }
    for (const ctrl of mod.controllers) {
      const list = controllerPrefixes.get(ctrl) ?? [];
      for (const prefix of prefixes) {
        if (!list.includes(prefix)) {
          list.push(prefix);
        }
      }
      controllerPrefixes.set(ctrl, list);
    }
  }

  return controllerPrefixes;
}

/**
 * Declarative hierarchical module routing prefix module matching NestJS `RouterModule`.
 *
 * Example:
 * ```ts
 * RouterModule.register([
 *   {
 *     path: "admin",
 *     module: AdminModule,
 *     children: [{ path: "users", module: UsersModule }],
 *   },
 * ])
 * ```
 */
@Module({})
export class RouterModule {
  static register(routes: Routes): DynamicModule {
    return {
      module: RouterModule,
      providers: [
        {
          provide: ROUTER_MODULE_ROUTES,
          useValue: [...routes],
        },
      ],
    };
  }
}
