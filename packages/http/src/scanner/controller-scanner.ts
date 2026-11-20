import {
  type ExceptionFilterLike,
  type GuardLike,
  type HeaderMetadata,
  type InterceptorLike,
  type LoggerService,
  MetadataRegistry,
  type MiddlewareLike,
  type ParameterMetadata,
  type PipeLike,
  type RedirectMetadata,
  type RouteConflictPolicy,
  type RouteConflictPolicyLevel,
  type RouteDefinition,
  type RouteResolutionStrategy,
  type Scope,
  type SseOptions,
  type Type,
  VERSION_NEUTRAL,
  type VersionValue,
  type VersioningOptions,
  VersioningType,
} from "@bunest/common";
import {
  DuplicateRouteException,
  InvalidControllerException,
  InvalidRouteException,
} from "../errors/routing.errors";
import type { GlobalPrefixOptions } from "../interfaces/http-bridge.interface";
import {
  canonicalizePath,
  isNativeBunRoutePath,
  matchesGlobalPrefixExclude,
  normalizePath,
} from "./path-normalizer";
import {
  formatUriVersionSegment,
  formatVersionCollisionKey,
  formatVersionLabel,
  normalizeVersionValue,
  type NormalizedVersionToken,
} from "./version-resolver";

export interface ScannedRoute extends RouteDefinition {
  readonly rawPathWithoutPrefix: string;
  readonly canonicalPath: string;
  readonly host?: string | RegExp | Array<string | RegExp>;
  readonly scope?: Scope;
  readonly versions?: readonly NormalizedVersionToken[];
  readonly handlerFn: Function;
  readonly isNativePathEligible: boolean;
  readonly controllerMiddlewares: readonly MiddlewareLike[];
  readonly methodMiddlewares: readonly MiddlewareLike[];
  readonly controllerGuards: readonly GuardLike[];
  readonly methodGuards: readonly GuardLike[];
  readonly controllerPipes: readonly PipeLike[];
  readonly methodPipes: readonly PipeLike[];
  readonly controllerInterceptors: readonly InterceptorLike[];
  readonly methodInterceptors: readonly InterceptorLike[];
  readonly controllerFilters: readonly ExceptionFilterLike[];
  readonly methodFilters: readonly ExceptionFilterLike[];
}

export interface ScanControllersOptions {
  readonly globalPrefix?: string | readonly string[];
  readonly globalPrefixOptions?: GlobalPrefixOptions;
  readonly controllerPrefixes?: ReadonlyMap<
    Type<unknown>,
    string | readonly string[]
  >;
  readonly versioning?: VersioningOptions;
  readonly routeConflictPolicy?: RouteConflictPolicy;
  readonly routeResolutionStrategy?: RouteResolutionStrategy;
  readonly logger?: LoggerService;
}

function normalizeConflictLevels(policy: RouteConflictPolicy | undefined): {
  duplicate: RouteConflictPolicyLevel;
  shadow: RouteConflictPolicyLevel;
} {
  if (!policy || policy === "throw") {
    return { duplicate: "error", shadow: "off" };
  }
  if (policy === "warn") {
    return { duplicate: "warn", shadow: "off" };
  }
  if (policy === "allow") {
    return { duplicate: "off", shadow: "off" };
  }
  return {
    duplicate: policy.duplicate ?? "off",
    shadow: policy.shadow ?? "off",
  };
}

function segmentKindRank(segment: string): number {
  if (segment === "*" || segment.includes("*")) return 2;
  if (segment.startsWith(":")) return 1;
  return 0;
}

function compareRouteSpecificity(a: ScannedRoute, b: ScannedRoute): number {
  const segA = a.fullPath.split("/").filter(Boolean);
  const segB = b.fullPath.split("/").filter(Boolean);
  const minLen = Math.min(segA.length, segB.length);
  for (let i = 0; i < minLen; i++) {
    const rankDiff = segmentKindRank(segA[i]!) - segmentKindRank(segB[i]!);
    if (rankDiff !== 0) {
      return rankDiff;
    }
  }
  return segB.length - segA.length;
}

function canEarlierPatternShadowLater(earlier: string, later: string): boolean {
  if (earlier === later) return false;
  const eSegs = earlier.split("/").filter(Boolean);
  const lSegs = later.split("/").filter(Boolean);

  for (let i = 0; i < eSegs.length; i++) {
    const es = eSegs[i]!;
    if (es === "*" || es.includes("*")) {
      return i < lSegs.length;
    }
    const ls = lSegs[i];
    if (ls === undefined) {
      return false;
    }
    if (es.startsWith(":")) {
      continue;
    }
    if (ls.startsWith(":") || ls === "*" || ls.includes("*")) {
      return false;
    }
    if (es !== ls) {
      return false;
    }
  }
  return eSegs.length === lSegs.length;
}

function normalizeHostCollisionKeys(
  host: string | RegExp | Array<string | RegExp> | undefined,
): string[] {
  if (host === undefined) {
    return [""];
  }
  const list = Array.isArray(host) ? host : [host];
  if (list.length === 0) {
    return [""];
  }
  return list.map((item) => {
    if (item instanceof RegExp) {
      return `regex:${item.source}/${item.flags}`;
    }
    // Canonicalize host param names (`:tenant.example.com` -> `:_.example.com`)
    return `host:${item
      .toLowerCase()
      .split(".")
      .map((label) => (label.startsWith(":") ? ":_" : label))
      .join(".")}`;
  });
}

function toStringArray(value: string | readonly string[]): string[] {
  if (Array.isArray(value)) {
    return value.length > 0 ? [...value] : [""];
  }
  return [value as string];
}

function resolveControllerPrefixesForClass(
  controller: Type<unknown>,
  controllerPrefixes:
    | ReadonlyMap<Type<unknown>, string | readonly string[]>
    | undefined,
): string[] {
  if (!controllerPrefixes || controllerPrefixes.size === 0) {
    return [""];
  }
  const entry = controllerPrefixes.get(controller);
  if (entry === undefined) {
    return [""];
  }
  return toStringArray(entry);
}

function assertUniqueParamIndices(
  controllerName: string,
  handlerKey: string | symbol,
  params: readonly ParameterMetadata[],
): void {
  const seen = new Set<number>();
  for (const param of params) {
    if (seen.has(param.index)) {
      throw new InvalidRouteException(
        `Duplicate parameter decorator on ${controllerName}.${String(handlerKey)} at parameter index ${param.index}.`,
      );
    }
    seen.add(param.index);
  }
}

function resolvePrecompiledRouteVersions(
  methodVersion: VersionValue | undefined,
  controllerVersion: VersionValue | undefined,
  versioning: VersioningOptions | undefined,
): readonly NormalizedVersionToken[] | undefined {
  if (!versioning) {
    return undefined;
  }
  if (methodVersion !== undefined) {
    return normalizeVersionValue(methodVersion) ?? [VERSION_NEUTRAL];
  }
  if (controllerVersion !== undefined) {
    return normalizeVersionValue(controllerVersion) ?? [VERSION_NEUTRAL];
  }
  if (versioning.defaultVersion !== undefined) {
    return (
      normalizeVersionValue(versioning.defaultVersion) ?? [VERSION_NEUTRAL]
    );
  }
  return [VERSION_NEUTRAL];
}

/**
 * Scans decorated `@Controller()` classes once at bootstrap using decorator-time
 * pre-indexed `PrecompiledControllerDescriptor`s from `@bunest/common`, expanding
 * multi-path controllers/methods, `RouterModule` controller prefixes, API Versioning
 * (`URI`, `HEADER`, `MEDIA_TYPE`, `CUSTOM`), normalizing paths, and failing fast on
 * duplicate/shadowed routes (RFC-001 & ADR-011).
 */
export function scanControllers(
  controllers: readonly Type<unknown>[],
  options: ScanControllersOptions = {},
): ScannedRoute[] {
  const scanned: ScannedRoute[] = [];
  const collisionRegistry = new Map<
    string,
    { path: string; controller: string; index: number }
  >();
  const versioning = options.versioning;
  const conflictLevels = normalizeConflictLevels(options.routeConflictPolicy);
  const resolutionStrategy = options.routeResolutionStrategy ?? "declaration";
  const globalPrefixes: string[] = !options.globalPrefix
    ? []
    : (Array.isArray(options.globalPrefix)
        ? options.globalPrefix
        : [options.globalPrefix]
      ).filter((p): p is string => typeof p === "string" && p.trim().length > 0);

  for (const controller of controllers) {
    if (typeof controller !== "function") {
      throw new InvalidControllerException(
        String(controller),
        `Invalid controller entry "${String(controller)}": expected a class constructor.`,
      );
    }

    const precompiled = MetadataRegistry.getPrecompiledController(controller);
    if (!precompiled) {
      throw new InvalidControllerException(controller.name || "AnonymousClass");
    }

    const controllerMeta = precompiled.metadata;
    const controllerName = controller.name || "AnonymousController";
    const routerPrefixes = resolveControllerPrefixesForClass(
      controller,
      options.controllerPrefixes,
    );
    const controllerPaths = precompiled.paths;
    const controllerMiddlewares = precompiled.controllerMiddlewares;
    const controllerGuards = precompiled.controllerGuards;
    const controllerPipes = precompiled.controllerPipes;
    const controllerInterceptors = precompiled.controllerInterceptors;
    const controllerFilters = precompiled.controllerFilters;
    const hostKeys = normalizeHostCollisionKeys(controllerMeta.host);

    for (const routeMeta of precompiled.routes) {
      if (typeof routeMeta.handlerFn !== "function") {
        throw new InvalidRouteException(
          `Route handler ${controllerName}.${String(routeMeta.handlerKey)} is not a function.`,
        );
      }
      const handlerFn = routeMeta.handlerFn;
      const parameters = routeMeta.parameters;
      assertUniqueParamIndices(controllerName, routeMeta.handlerKey, parameters);

      const httpCode = routeMeta.httpCode;
      const headers = routeMeta.headers as HeaderMetadata[];
      const redirect: RedirectMetadata | undefined = routeMeta.redirect;
      const renderTemplate = routeMeta.renderTemplate;
      const isSse = routeMeta.isSse;
      const sseOptions: SseOptions | undefined = routeMeta.sseOptions;

      const methodMiddlewares = routeMeta.methodMiddlewares;
      const methodGuards = routeMeta.methodGuards;
      const methodPipes = routeMeta.methodPipes;
      const methodInterceptors = routeMeta.methodInterceptors;
      const methodFilters = routeMeta.methodFilters;

      const resolvedVersions = resolvePrecompiledRouteVersions(
        routeMeta.methodVersion,
        precompiled.controllerVersion,
        versioning,
      );

      const methodPaths = routeMeta.paths;

      // Deduplicate raw combined paths for a single handler when RouterModule prefixes collapse
      const emittedRawPaths = new Set<string>();

      for (const routerPrefix of routerPrefixes) {
        for (const ctrlPath of controllerPaths) {
          for (const methodPath of methodPaths) {
            const rawPathWithoutPrefix = normalizePath(
              routerPrefix,
              ctrlPath,
              methodPath,
            );
            if (emittedRawPaths.has(rawPathWithoutPrefix)) {
              continue;
            }
            emittedRawPaths.add(rawPathWithoutPrefix);

            const skipPrefix =
              globalPrefixes.length === 0 ||
              matchesGlobalPrefixExclude(
                routeMeta.method,
                rawPathWithoutPrefix,
                options.globalPrefixOptions?.exclude,
              );

            const activePrefixes: Array<string | undefined> = skipPrefix
              ? [undefined]
              : globalPrefixes;

            const recordScannedRoute = (
              collisionKeys: readonly string[],
              entry: ScannedRoute,
              duplicateVersionLabel?: string,
            ) => {
              let duplicateIdx: number | undefined;
              for (const collisionKey of collisionKeys) {
                const existing = collisionRegistry.get(collisionKey);
                if (existing) {
                  if (conflictLevels.duplicate === "error") {
                    throw new DuplicateRouteException({
                      method: routeMeta.method,
                      path: entry.fullPath,
                      canonicalPath: entry.canonicalPath,
                      host: entry.host ? String(entry.host) : undefined,
                      version: duplicateVersionLabel,
                      existingPath: existing.path,
                      existingController: existing.controller,
                      attemptedController: `${controllerName}.${String(routeMeta.handlerKey)}`,
                    });
                  }
                  if (conflictLevels.duplicate === "warn") {
                    options.logger?.warn(
                      `Duplicate route ${routeMeta.method} ${entry.fullPath} (${controllerName}.${String(routeMeta.handlerKey)} overrides ${existing.controller})`,
                    );
                  }
                  duplicateIdx = existing.index;
                }
              }

              let targetIdx: number;
              if (duplicateIdx !== undefined) {
                scanned[duplicateIdx] = entry;
                targetIdx = duplicateIdx;
              } else {
                targetIdx = scanned.length;
                scanned.push(entry);
              }

              for (const collisionKey of collisionKeys) {
                collisionRegistry.set(collisionKey, {
                  path: entry.fullPath,
                  controller: `${controllerName}.${String(routeMeta.handlerKey)}`,
                  index: targetIdx,
                });
              }
            };

            for (const activePrefix of activePrefixes) {
              if (versioning && versioning.type === VersioningType.URI) {
                // URI Versioning expands each version token into its own concrete route path:
                // [globalPrefix] + [versionSegment] + [routerPrefix + ctrlPath + methodPath]
                const tokens = resolvedVersions ?? [];
                for (const token of tokens) {
                  const versionSegment = formatUriVersionSegment(
                    token,
                    versioning,
                  );
                  const fullPath = activePrefix
                    ? normalizePath(
                        activePrefix,
                        versionSegment,
                        rawPathWithoutPrefix,
                      )
                    : normalizePath(versionSegment, rawPathWithoutPrefix);
                  const canonicalPath = canonicalizePath(fullPath);

                  const keys = hostKeys.map(
                    (hk) => `${routeMeta.method}|${hk}|${canonicalPath}`,
                  );
                  recordScannedRoute(
                    keys,
                    {
                      method: routeMeta.method,
                      path: rawPathWithoutPrefix,
                      fullPath,
                      rawPathWithoutPrefix,
                      canonicalPath,
                      controller,
                      controllerToken: controller,
                      handlerKey: routeMeta.handlerKey,
                      handlerFn,
                      parameters,
                      httpCode,
                      headers: headers.length > 0 ? headers : undefined,
                      redirect,
                      renderTemplate,
                      isSse: isSse || undefined,
                      sseOptions,
                      version: token,
                      host: controllerMeta.host,
                      scope: controllerMeta.scope,
                      versions: [token],
                      isNativePathEligible:
                        controllerMeta.host === undefined &&
                        isNativeBunRoutePath(fullPath),
                      controllerMiddlewares,
                      methodMiddlewares: [...methodMiddlewares],
                      controllerGuards,
                      methodGuards: [...methodGuards],
                      controllerPipes,
                      methodPipes: [...methodPipes],
                      controllerInterceptors,
                      methodInterceptors: [...methodInterceptors],
                      controllerFilters,
                      methodFilters: [...methodFilters],
                    },
                    formatVersionLabel(token),
                  );
                }
                continue;
              }

              // Standard unversioned OR runtime-versioned (HEADER / MEDIA_TYPE / CUSTOM) route
              const fullPath = activePrefix
                ? normalizePath(activePrefix, rawPathWithoutPrefix)
                : rawPathWithoutPrefix;

              const canonicalPath = canonicalizePath(fullPath);

              const keys: string[] = [];
              let dupVerLabel: string | undefined;
              // When enableVersioning() has not been called yet (e.g. during BunestFactory.create()
              // right before the user invokes app.enableVersioning()), still partition collision keys
              // by any explicit @Version() / @Controller({ version }) metadata so distinctly versioned
              // handlers on the same path don't spuriously throw DuplicateRouteException prematurely.
              const explicitPreVersioningTokens =
                versioning === undefined
                  ? normalizeVersionValue(
                      routeMeta.methodVersion ?? precompiled.controllerVersion,
                    )
                  : undefined;
              const collisionVersionTokens =
                versioning && resolvedVersions && resolvedVersions.length > 0
                  ? resolvedVersions
                  : explicitPreVersioningTokens;

              if (collisionVersionTokens && collisionVersionTokens.length > 0) {
                dupVerLabel = collisionVersionTokens
                  .map(formatVersionLabel)
                  .join(", ");
                for (const hostKey of hostKeys) {
                  for (const token of collisionVersionTokens) {
                    const versionKey = formatVersionCollisionKey(token);
                    keys.push(
                      `${routeMeta.method}|${hostKey}|${versionKey}|${canonicalPath}`,
                    );
                  }
                }
              } else {
                for (const hostKey of hostKeys) {
                  keys.push(`${routeMeta.method}|${hostKey}|${canonicalPath}`);
                }
              }

              recordScannedRoute(
                keys,
                {
                  method: routeMeta.method,
                  path: rawPathWithoutPrefix,
                  fullPath,
                  rawPathWithoutPrefix,
                  canonicalPath,
                  controller,
                  controllerToken: controller,
                  handlerKey: routeMeta.handlerKey,
                  handlerFn,
                  parameters,
                  httpCode,
                  headers: headers.length > 0 ? headers : undefined,
                  redirect,
                  renderTemplate,
                  isSse: isSse || undefined,
                  sseOptions,
                  version:
                    resolvedVersions && resolvedVersions.length === 1
                      ? resolvedVersions[0]
                      : resolvedVersions
                        ? [...resolvedVersions]
                        : undefined,
                  host: controllerMeta.host,
                  scope: controllerMeta.scope,
                  versions: resolvedVersions,
                  isNativePathEligible:
                    controllerMeta.host === undefined &&
                    isNativeBunRoutePath(fullPath),
                  controllerMiddlewares,
                  methodMiddlewares: [...methodMiddlewares],
                  controllerGuards,
                  methodGuards: [...methodGuards],
                  controllerPipes,
                  methodPipes: [...methodPipes],
                  controllerInterceptors,
                  methodInterceptors: [...methodInterceptors],
                  controllerFilters,
                  methodFilters: [...methodFilters],
                },
                dupVerLabel,
              );
            }
          }
        }
      }
    }
  }

  if (resolutionStrategy === "specificity") {
    scanned.sort(compareRouteSpecificity);
  }

  if (conflictLevels.shadow !== "off" && scanned.length > 1) {
    for (let i = 0; i < scanned.length; i++) {
      const earlier = scanned[i]!;
      for (let j = i + 1; j < scanned.length; j++) {
        const later = scanned[j]!;
        if (
          earlier.method !== later.method &&
          earlier.method !== "ALL" &&
          later.method !== "ALL"
        ) {
          continue;
        }
        if (String(earlier.host ?? "") !== String(later.host ?? "")) {
          continue;
        }
        if (
          earlier.canonicalPath !== later.canonicalPath &&
          canEarlierPatternShadowLater(earlier.fullPath, later.fullPath)
        ) {
          const earlierCtrl = `${earlier.controller.name}.${String(earlier.handlerKey)}`;
          const laterCtrl = `${later.controller.name}.${String(later.handlerKey)}`;
          const message = `Shadowed route detected: ${earlier.method} ${earlier.fullPath} (${earlierCtrl}) shadows ${later.method} ${later.fullPath} (${laterCtrl})`;
          if (conflictLevels.shadow === "error") {
            const err = new DuplicateRouteException({
              method: later.method,
              path: later.fullPath,
              canonicalPath: later.canonicalPath,
              existingPath: earlier.fullPath,
              existingController: earlierCtrl,
              attemptedController: laterCtrl,
            });
            err.message = message;
            throw err;
          }
          options.logger?.warn(message);
        }
      }
    }
  }

  return scanned;
}
