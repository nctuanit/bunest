import {
  type BunestInterceptor,
  type BunestMiddleware,
  type CanActivate,
  type ExceptionFilter,
  type ExceptionFilterLike,
  type GuardLike,
  type HttpMethod,
  HttpStatus,
  type InjectableMetadata,
  type InjectionToken,
  type InterceptorLike,
  METADATA_KEYS,
  MetadataRegistry,
  MethodNotAllowedException,
  NotFoundException,
  type PipeLike,
  type PipeTransform,
  type RequestMethod,
  type RouteDefinition,
  Scope,
  type SecurityRequestHook,
  VERSION_NEUTRAL,
  type VersioningOptions,
  type ViewEngineRenderer,
} from "../../common/index";
import { RequestContext } from "../context/request-context";
import type {
  BunServerLike,
  CompiledMiddlewareConfig,
  HttpRuntimeBridge,
  MultipartStorageOptions,
} from "../interfaces/http-bridge.interface";
import {
  type CompiledExceptionFilter,
  type DefaultExceptionFilter,
} from "../pipeline/exception-handler";
import {
  buildFilterSpec,
  type CompiledRoute,
  executeCompiledRoute,
  executeFallbackException,
  isRouteExplicitlyRequestScoped,
  type MiddlewareEntry,
  type PipelineRuntimeConfig,
  type ResolvedMiddleware,
} from "../pipeline/execution-pipeline";
import { compileParameters } from "../pipeline/param-extractor";
import type { ScannedRoute } from "../scanner/controller-scanner";
import {
  evaluateMiddlewareForRoute,
  matchesRouteInfo,
  normalizePath,
  type VersionedRouteRule,
} from "../scanner/path-normalizer";
import {
  extractRequestVersions,
  isRuntimeVersioning,
} from "../scanner/version-resolver";
import {
  createPreflightResponse,
  evaluateCors,
  isCorsPreflightRequest,
  type NormalizedCorsOptions,
} from "../security/cors";
import type { CompiledCsrfProtection } from "../security/csrf-protection";
import {
  applySecurityHeaders,
  type CompiledSecurityHeaders,
} from "../security/security-headers";
import { isDangerousKey } from "../security/prototype-sanitizer";
import {
  computeAllowHeader,
  FallbackRadixRouter,
  NativePathMatcher,
} from "./fallback-radix-router";

export type CompiledPathDispatcher = (
  req: Request,
  server?: BunServerLike,
  overrideParams?: Record<string, string>,
) => Response | Promise<Response>;

export interface CompiledRouteTable {
  readonly routes: readonly RouteDefinition[];
  readonly compiledRoutes: readonly CompiledRoute[];
  readonly bunRoutes: Record<
    string,
    (req: Request, server: BunServerLike) => Response | Promise<Response>
  >;
  readonly nativeMatcher: NativePathMatcher<CompiledPathDispatcher>;
  readonly fallbackRouter: FallbackRadixRouter;
  readonly runtime: PipelineRuntimeConfig;
}

export interface RouteCompilerInput {
  readonly scannedRoutes: readonly ScannedRoute[];
  readonly bridge: HttpRuntimeBridge;
  readonly globalMiddlewares: readonly MiddlewareEntry[];
  readonly moduleMiddlewares: readonly CompiledMiddlewareConfig[];
  readonly globalGuards: readonly GuardLike[];
  readonly globalPipes: readonly PipeLike[];
  readonly globalInterceptors: readonly InterceptorLike[];
  readonly globalFilters: readonly ExceptionFilterLike[];
  readonly cors?: NormalizedCorsOptions;
  readonly csrfProtection?: CompiledCsrfProtection;
  readonly securityHeaders?: CompiledSecurityHeaders;
  readonly cookieSecrets?: readonly string[];
  readonly bodyLimit?: number;
  readonly bodyParser?: boolean;
  readonly rawBody?: boolean;
  readonly multipart?: MultipartStorageOptions;
  readonly versioning?: VersioningOptions;
  readonly trustProxy?: boolean | number | string[];
  readonly viewRenderer?: ViewEngineRenderer;
  readonly baseViewsDir?: string;
  readonly defaultFilter: DefaultExceptionFilter;
  readonly onRequestHook?: Function;
  readonly onResponseHook?: Function;
  readonly onRouteTriggered?: (
    requestMethod: RequestMethod,
    path: string,
  ) => void;
  readonly securityHooks?: readonly SecurityRequestHook<Request>[];
  readonly mapException?: (error: unknown) => unknown;
  readonly customErrorHandler?: {
    readonly handler: Function;
    readonly prefix?: string;
  };
}

interface VersionedCompiledGroup {
  readonly byVersion: Map<string, CompiledRoute>;
  neutral?: CompiledRoute;
}

function addCompiledToVersionGroup(
  group: VersionedCompiledGroup,
  compiled: CompiledRoute,
): void {
  const versions = compiled.route.versions;
  if (!versions || versions.length === 0) {
    group.neutral = compiled;
    return;
  }
  for (let i = 0; i < versions.length; i++) {
    const token = versions[i];
    if (token === VERSION_NEUTRAL) {
      group.neutral = compiled;
    } else if (typeof token === "string") {
      group.byVersion.set(token, compiled);
    }
  }
}

function matchCompiledVersionGroup(
  group: VersionedCompiledGroup | undefined,
  requestedVersions: readonly string[],
): CompiledRoute | undefined {
  if (!group) {
    return undefined;
  }
  for (let i = 0; i < requestedVersions.length; i++) {
    const ver = requestedVersions[i];
    if (ver !== undefined) {
      const hit = group.byVersion.get(ver);
      if (hit) {
        return hit;
      }
    }
  }
  if (group.neutral) {
    const versions = group.neutral.route.versions;
    const hasExplicitAlongWithNeutral =
      versions !== undefined &&
      versions.length > 1 &&
      versions.includes(VERSION_NEUTRAL);
    if (hasExplicitAlongWithNeutral && requestedVersions.length > 0) {
      return undefined;
    }
    return group.neutral;
  }
  return undefined;
}

function computeAllowHeaderForVersion(
  versionedMethods: Partial<Record<HttpMethod, VersionedCompiledGroup>>,
  versionedAll: VersionedCompiledGroup | undefined,
  requestedVersions: readonly string[],
): string {
  if (matchCompiledVersionGroup(versionedAll, requestedVersions)) {
    return computeAllowHeader({}, true);
  }
  const matchedMethods: Partial<Record<HttpMethod, boolean>> = {};
  let hasAny = false;
  for (const key of Object.keys(versionedMethods) as HttpMethod[]) {
    if (matchCompiledVersionGroup(versionedMethods[key], requestedVersions)) {
      matchedMethods[key] = true;
      hasAny = true;
    }
  }
  return hasAny ? computeAllowHeader(matchedMethods, false) : "";
}

function isMiddlewareClassCtor(
  value: unknown,
): value is new (...args: any[]) => BunestMiddleware {
  return (
    typeof value === "function" &&
    typeof (value as { prototype?: { use?: unknown } }).prototype?.use ===
      "function"
  );
}

function collectClassTokens(
  middlewares: readonly MiddlewareEntry[],
  guards: readonly GuardLike[],
  interceptors: readonly InterceptorLike[],
  sharedPipes: readonly PipeLike[],
  paramPipes: readonly PipeLike[],
  filters: readonly ExceptionFilterLike[],
): InjectionToken[] {
  const tokens: InjectionToken[] = [];
  for (const mw of middlewares) {
    if (isMiddlewareClassCtor(mw)) tokens.push(mw);
  }
  for (const g of guards) {
    if (typeof g === "function") tokens.push(g);
  }
  for (const ic of interceptors) {
    if (typeof ic === "function") tokens.push(ic);
  }
  for (const p of sharedPipes) {
    if (typeof p === "function") tokens.push(p);
  }
  for (const p of paramPipes) {
    if (typeof p === "function") tokens.push(p);
  }
  for (const f of filters) {
    if (typeof f === "function") tokens.push(f);
  }
  return tokens;
}

function isTokenExplicitlyRequestScoped(token: unknown): boolean {
  if (typeof token !== "function") {
    return false;
  }
  const meta = MetadataRegistry.get<InjectableMetadata>(
    METADATA_KEYS.INJECTABLE,
    token,
  );
  return meta?.scope === Scope.REQUEST;
}

function isFilterSpecRequestScoped(
  spec: ExceptionFilterLike,
  bridge: HttpRuntimeBridge,
): boolean {
  if (bridge.requiresEnhancerRequestScope) {
    return bridge.requiresEnhancerRequestScope(spec, "filter");
  }
  if (typeof spec !== "function") {
    return false;
  }
  if (isTokenExplicitlyRequestScoped(spec)) {
    return true;
  }
  return bridge.requiresRequestScope?.(spec, [spec]) ?? false;
}

function buildFilterSpecWithBridge(
  spec: ExceptionFilterLike,
  bridge: HttpRuntimeBridge,
): {
  readonly spec: ExceptionFilterLike;
  readonly catchTypes: readonly (new (...args: any[]) => any)[];
} {
  const overridden = bridge.resolveFilterCatchTypes?.(spec);
  if (overridden !== undefined) {
    return { spec, catchTypes: overridden };
  }
  return buildFilterSpec(spec);
}

function hasOnlySafeNativeParamNames(normalizedPath: string): boolean {
  if (!normalizedPath.includes(":")) {
    return true;
  }
  const segments = normalizedPath.slice(1).split("/");
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg && seg.startsWith(":") && isDangerousKey(seg.slice(1))) {
      return false;
    }
  }
  return true;
}

const REGEX_PARAM_SEG_RE = /^:[A-Za-z_][A-Za-z0-9_]*\((.+)\)(\?)?$/;
const OPTIONAL_PARAM_SEG_RE = /^:[A-Za-z_][A-Za-z0-9_]*\?$/;

function isOptionalFallbackSegment(seg: string): boolean {
  if (OPTIONAL_PARAM_SEG_RE.test(seg)) return true;
  const regexMatch = REGEX_PARAM_SEG_RE.exec(seg);
  return regexMatch !== null && regexMatch[2] === "?";
}

function singleSegmentCanOverlap(
  nativeSeg: string,
  fallbackSeg: string,
): boolean {
  if (nativeSeg.startsWith(":")) {
    return true;
  }
  if (fallbackSeg.startsWith(":")) {
    const regexMatch = REGEX_PARAM_SEG_RE.exec(fallbackSeg);
    if (regexMatch) {
      try {
        return new RegExp(`^(?:${regexMatch[1]!})$`).test(nativeSeg);
      } catch {
        return true;
      }
    }
    return true;
  }
  return nativeSeg === fallbackSeg;
}

/**
 * Determines whether a native Bun.serve route path could intercept a concrete URL
 * intended for a FallbackRadixRouter path (e.g., `/items/:slug` shadowing `/items/:id(\d+)`,
 * `/archive/:year` shadowing `/archive/:year/:month?`, mid-path wildcards,
 * or trailing catch-all wildcards shadowing any fallback route under that prefix).
 */
function expandFallbackOptionalGroups(rawPath: string): string[] {
  const openIdx = rawPath.indexOf("{");
  if (openIdx === -1) {
    const cleaned = rawPath.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
    return [cleaned];
  }
  const closeIdx = rawPath.indexOf("}", openIdx + 1);
  if (closeIdx === -1) return [rawPath];
  const before = rawPath.slice(0, openIdx);
  const inside = rawPath.slice(openIdx + 1, closeIdx);
  const after = rawPath.slice(closeIdx + 1);
  return [
    ...expandFallbackOptionalGroups(before + inside + after),
    ...expandFallbackOptionalGroups(before + after),
  ];
}

function canNativePathOverlapFallback(
  nativePath: string,
  fallbackPath: string,
  fallbackHasHost: boolean,
): boolean {
  const nativeHasParamOrWildcard =
    nativePath.includes(":") || nativePath.includes("*");
  const fallbackHasMixedOrOptional =
    fallbackPath.includes("{") ||
    fallbackPath
      .split("/")
      .some((s) => s.includes(":") && !/^:[A-Za-z_][A-Za-z0-9_]*$/.test(s));

  if (
    !nativeHasParamOrWildcard &&
    !fallbackHasHost &&
    !fallbackHasMixedOrOptional
  ) {
    return false;
  }

  const variants = fallbackPath.includes("{")
    ? expandFallbackOptionalGroups(fallbackPath)
    : [fallbackPath];
  const nSegs = nativePath === "/" ? [] : nativePath.slice(1).split("/");

  for (const variant of variants) {
    const fSegs = variant === "/" ? [] : variant.slice(1).split("/");
    const memo = new Map<string, boolean>();

    const overlaps = (ni: number, fi: number): boolean => {
      const key = `${ni}:${fi}`;
      const cached = memo.get(key);
      if (cached !== undefined) {
        return cached;
      }

      let result = false;

      if (ni === nSegs.length && fi === fSegs.length) {
        result = true;
      } else if (
        fi < fSegs.length &&
        isOptionalFallbackSegment(fSegs[fi]!) &&
        overlaps(ni, fi + 1)
      ) {
        result = true;
      } else if (ni < nSegs.length && nSegs[ni] === "*") {
        result = true;
      } else if (ni < nSegs.length && fi < fSegs.length) {
        const nSeg = nSegs[ni]!;
        const fSeg = fSegs[fi]!;

        if (fSeg === "*" || fSeg.startsWith("*")) {
          if (fi === fSegs.length - 1) {
            result = true;
          } else {
            for (let nextNi = ni + 1; nextNi <= nSegs.length; nextNi++) {
              if (overlaps(nextNi, fi + 1)) {
                result = true;
                break;
              }
            }
          }
        } else if (
          fSeg.includes(":") ||
          singleSegmentCanOverlap(nSeg, fSeg)
        ) {
          result = overlaps(ni + 1, fi + 1);
        }
      }

      memo.set(key, result);
      return result;
    };

    if (overlaps(0, 0)) {
      return true;
    }
  }

  return false;
}

async function resolveMiddlewareSingleton(
  entry: MiddlewareEntry,
  bridge: HttpRuntimeBridge,
  controllerToken?: new (...args: any[]) => unknown,
): Promise<ResolvedMiddleware> {
  if (typeof entry === "object" && entry !== null && "use" in entry) {
    return entry;
  }
  if (isMiddlewareClassCtor(entry)) {
    return bridge.resolveEnhancer<BunestMiddleware>(
      entry,
      undefined,
      undefined,
      controllerToken,
    );
  }
  return entry;
}

/**
 * Compiles scanned controller routes once at bootstrap into:
 * 1. `Bun.serve({ routes })` per-path O(1) compiled dispatchers (ADR-011)
 * 2. `NativePathMatcher` sharing those exact closures for `adapter.fetch()` & `ignoreTrailingSlash`
 * 3. `FallbackRadixRouter` for host-constrained / optional / regex / mid-wildcard routes
 */
export async function compileRoutes(
  input: RouteCompilerInput,
): Promise<CompiledRouteTable> {
  const {
    scannedRoutes,
    bridge,
    globalMiddlewares,
    moduleMiddlewares,
    globalGuards,
    globalPipes,
    globalInterceptors,
    globalFilters,
    cors,
    csrfProtection,
    securityHeaders,
    cookieSecrets,
    bodyLimit,
    bodyParser,
    rawBody,
    multipart,
    versioning,
    trustProxy,
    viewRenderer,
    baseViewsDir,
    defaultFilter,
    onRequestHook,
    onResponseHook,
    onRouteTriggered,
    securityHooks,
    mapException,
    customErrorHandler,
  } = input;

  const runtimeVersioning = isRuntimeVersioning(versioning);

  // Pre-compile global exception filters (for fallback 404/405 & shared specs).
  const globalFilterSpecs = globalFilters.map((f) =>
    buildFilterSpecWithBridge(f, bridge),
  );
  const hasRequestScopedGlobalFilter = globalFilterSpecs.some((fs) =>
    isFilterSpecRequestScoped(fs.spec, bridge),
  );

  const resolvedGlobalFilters: CompiledExceptionFilter[] = [];
  if (!hasRequestScopedGlobalFilter) {
    for (let i = 0; i < globalFilterSpecs.length; i++) {
      const spec = globalFilterSpecs[i];
      if (!spec) continue;
      const instance = await bridge.resolveEnhancer<ExceptionFilter>(
        spec.spec,
        undefined,
        "filter",
      );
      const catchTypes =
        bridge.resolveFilterCatchTypes?.(spec.spec, instance) ??
        spec.catchTypes;
      resolvedGlobalFilters.push({
        filter: instance,
        catchTypes,
      });
    }
  }

  const runtime: PipelineRuntimeConfig = {
    bridge,
    cors,
    csrfProtection,
    securityHeaders,
    bodyLimit,
    hasDiskMultipart: Boolean(multipart?.diskStorageDir),
    viewRenderer,
    baseViewsDir,
    defaultFilter,
    globalFilters: resolvedGlobalFilters,
    globalFilterSpecs,
    hasRequestScopedGlobalFilter,
    onRequestHook,
    onResponseHook,
    onRouteTriggered,
    securityHooks:
      securityHooks && securityHooks.length > 0
        ? [...securityHooks]
        : undefined,
    mapException,
    customErrorHandler,
  };

  // Pre-compile each route's execution plan
  const compiledRoutes: CompiledRoute[] = [];

  for (let i = 0; i < scannedRoutes.length; i++) {
    const route = scannedRoutes[i];
    if (!route) continue;

    // Pre-match module middlewares at bootstrap (zero per-request path matching for static routes;
    // runtime guard only when dynamic exclude or runtime-versioned include/exclude applies)
    const matchedModuleMiddlewares: MiddlewareEntry[] = [];
    for (let m = 0; m < moduleMiddlewares.length; m++) {
      const cfg = moduleMiddlewares[m];
      if (!cfg) continue;
      const mode = evaluateMiddlewareForRoute(
        cfg,
        route.method,
        route.fullPath,
        route.rawPathWithoutPrefix,
        route.versions,
        runtimeVersioning,
      );
      if (mode === "always") {
        matchedModuleMiddlewares.push(cfg.middleware);
      } else if (mode === "runtime") {
        const innerMw = await resolveMiddlewareSingleton(
          cfg.middleware,
          bridge,
          route.controller,
        );
        const rawPrefixLen =
          route.fullPath !== route.rawPathWithoutPrefix &&
          route.fullPath.endsWith(route.rawPathWithoutPrefix)
            ? route.fullPath.length - route.rawPathWithoutPrefix.length
            : 0;
        const wrappedMw: MiddlewareEntry = (req, res, next) => {
          const url = new URL(req.url);
          const rawPathname = url.pathname;
          let decodedPathname: string;
          try {
            decodedPathname = decodeURIComponent(rawPathname);
          } catch {
            decodedPathname = rawPathname;
          }
          const reqMethod = req.method.toUpperCase() as HttpMethod;
          const reqVersions =
            runtimeVersioning && versioning
              ? extractRequestVersions(req, versioning)
              : route.versions;
          const strippedPathname =
            rawPrefixLen > 0 && rawPathname.length >= rawPrefixLen
              ? normalizePath(rawPathname.slice(rawPrefixLen))
              : rawPathname;
          const runtimeCandidates =
            strippedPathname === rawPathname
              ? [rawPathname]
              : [rawPathname, strippedPathname];

          if (cfg.include && cfg.include.length > 0) {
            const included = cfg.include.some((rule) =>
              matchesRouteInfo(
                rule as string | VersionedRouteRule,
                reqMethod,
                runtimeCandidates,
                reqVersions,
                { allowStringPrefixMount: true },
              ),
            );
            if (!included) {
              return next();
            }
          }

          if (cfg.exclude && cfg.exclude.length > 0) {
            // Line terminators in decoded pathname must never bypass middleware via exclude patterns
            const hasLineTerminator = /[\r\n\u2028\u2029]/.test(decodedPathname);
            if (!hasLineTerminator) {
              const excluded = cfg.exclude.some((rule) =>
                matchesRouteInfo(
                  rule as string | VersionedRouteRule,
                  reqMethod,
                  runtimeCandidates,
                  reqVersions,
                ),
              );
              if (excluded) {
                return next();
              }
            }
          }

          if (innerMw) {
            return typeof innerMw === "function"
              ? innerMw(req, res, next)
              : innerMw.use(req, res, next);
          }
          return next();
        };
        matchedModuleMiddlewares.push(wrappedMw);
      }
    }

    const middlewareSpecs: MiddlewareEntry[] = [
      ...globalMiddlewares,
      ...matchedModuleMiddlewares,
      ...((route.controllerMiddlewares ?? []) as readonly MiddlewareEntry[]),
      ...((route.methodMiddlewares ?? []) as readonly MiddlewareEntry[]),
    ];

    // Strict ADR-008 §3 enhancer precedence
    const guardSpecs: GuardLike[] = [
      ...globalGuards,
      ...route.controllerGuards,
      ...route.methodGuards,
    ];
    const interceptorSpecs: InterceptorLike[] = [
      ...globalInterceptors,
      ...route.controllerInterceptors,
      ...route.methodInterceptors,
    ];
    const sharedPipeSpecs: PipeLike[] = [
      ...globalPipes,
      ...route.controllerPipes,
      ...route.methodPipes,
    ];
    // Exception Filters: Method -> Controller -> Global (most specific first)
    const filterSpecs = [
      ...route.methodFilters.map((f) => buildFilterSpecWithBridge(f, bridge)),
      ...route.controllerFilters.map((f) =>
        buildFilterSpecWithBridge(f, bridge),
      ),
      ...globalFilterSpecs,
    ];

    const { compiled: compiledParams, argCount } = compileParameters(
      route.parameters,
    );

    const allParamPipeSpecs: PipeLike[] = [];
    let hasCustomParam = false;
    for (const cp of compiledParams) {
      if (cp.source === "custom") {
        hasCustomParam = true;
      }
      if (cp.paramPipes.length > 0) {
        allParamPipeSpecs.push(...cp.paramPipes);
      }
    }

    const enhancerTokens = collectClassTokens(
      middlewareSpecs,
      guardSpecs,
      interceptorSpecs,
      sharedPipeSpecs,
      allParamPipeSpecs,
      [...route.methodFilters, ...route.controllerFilters, ...globalFilters],
    );

    const requiresRequestScope = bridge.requiresEnhancerRequestScope
      ? isRouteExplicitlyRequestScoped(route) ||
        hasRequestScopedGlobalFilter ||
        (bridge.requiresRequestScope?.(route.controller, []) ?? false) ||
        middlewareSpecs.some(
          (mw) =>
            isMiddlewareClassCtor(mw) &&
            bridge.requiresEnhancerRequestScope!(
              mw,
              undefined,
              route.controller,
            ),
        ) ||
        guardSpecs.some((g) =>
          bridge.requiresEnhancerRequestScope!(g, "guard", route.controller),
        ) ||
        interceptorSpecs.some((ic) =>
          bridge.requiresEnhancerRequestScope!(
            ic,
            "interceptor",
            route.controller,
          ),
        ) ||
        sharedPipeSpecs.some((p) =>
          bridge.requiresEnhancerRequestScope!(p, "pipe", route.controller),
        ) ||
        allParamPipeSpecs.some((p) =>
          bridge.requiresEnhancerRequestScope!(p, "pipe", route.controller),
        ) ||
        [
          ...route.methodFilters,
          ...route.controllerFilters,
          ...globalFilters,
        ].some((f) =>
          bridge.requiresEnhancerRequestScope!(f, "filter", route.controller),
        )
      : isRouteExplicitlyRequestScoped(route) ||
        hasRequestScopedGlobalFilter ||
        enhancerTokens.some((tok) => isTokenExplicitlyRequestScoped(tok)) ||
        (bridge.requiresRequestScope?.(route.controller, enhancerTokens) ??
          false);

    if (!requiresRequestScope) {
      // Pure singleton fast path: resolve every instance once at bootstrap
      const singletonController = await bridge.resolveController(
        route.controller,
      );
      const singletonHandler = (
        singletonController as Record<string | symbol, unknown>
      )[route.handlerKey] as (...args: unknown[]) => unknown;

      const singletonMiddlewares: ResolvedMiddleware[] = [];
      for (const mw of middlewareSpecs) {
        singletonMiddlewares.push(
          await resolveMiddlewareSingleton(mw, bridge, route.controller),
        );
      }

      const singletonGuards: CanActivate[] = [];
      for (const g of guardSpecs) {
        singletonGuards.push(
          await bridge.resolveEnhancer<CanActivate>(
            g,
            undefined,
            "guard",
            route.controller,
          ),
        );
      }

      const singletonInterceptors: BunestInterceptor[] = [];
      for (const ic of interceptorSpecs) {
        singletonInterceptors.push(
          await bridge.resolveEnhancer<BunestInterceptor>(
            ic,
            undefined,
            "interceptor",
            route.controller,
          ),
        );
      }

      const singletonSharedPipes: PipeTransform[] = [];
      for (const p of sharedPipeSpecs) {
        singletonSharedPipes.push(
          await bridge.resolveEnhancer<PipeTransform>(
            p,
            undefined,
            "pipe",
            route.controller,
          ),
        );
      }

      const singletonParamPipes: PipeTransform[][] = [];
      for (const cp of compiledParams) {
        const resolved: PipeTransform[] = [];
        for (const p of cp.paramPipes) {
          resolved.push(
            await bridge.resolveEnhancer<PipeTransform>(
              p,
              undefined,
              "pipe",
              route.controller,
            ),
          );
        }
        singletonParamPipes.push(resolved);
      }

      const singletonFilters: CompiledExceptionFilter[] = [];
      for (const fs of filterSpecs) {
        const instance = await bridge.resolveEnhancer<ExceptionFilter>(
          fs.spec,
          undefined,
          "filter",
          route.controller,
        );
        const catchTypes =
          bridge.resolveFilterCatchTypes?.(fs.spec, instance) ?? fs.catchTypes;
        singletonFilters.push({
          filter: instance,
          catchTypes,
        });
      }

      const hasRuntimeHooks =
        Boolean(onRequestHook) ||
        Boolean(onResponseHook) ||
        Boolean(onRouteTriggered) ||
        Boolean(securityHooks && securityHooks.length > 0) ||
        Boolean(customErrorHandler);
      const isFastSingleton =
        singletonMiddlewares.length === 0 &&
        singletonGuards.length === 0 &&
        singletonInterceptors.length === 0 &&
        !cors &&
        !csrfProtection &&
        !securityHeaders &&
        !route.renderTemplate &&
        !hasRuntimeHooks;
      const isStandardResponse =
        !route.redirect &&
        !route.isSse &&
        !route.renderTemplate &&
        !(route.headers && route.headers.length > 0) &&
        route.method !== "ALL";
      const defaultStatus =
        route.httpCode ??
        (route.method === "POST" ? HttpStatus.CREATED : HttpStatus.OK);

      compiledRoutes.push({
        route,
        compiledParams,
        argCount,
        requiresRequestScope: false,
        middlewareSpecs,
        guardSpecs,
        interceptorSpecs,
        sharedPipeSpecs,
        filterSpecs,
        singletonController,
        singletonHandler,
        singletonMiddlewares,
        singletonGuards,
        singletonInterceptors,
        singletonSharedPipes,
        singletonParamPipes,
        singletonFilters,
        isFastSingleton,
        isStandardResponse,
        defaultStatus,
        hasCustomParam,
      });
    } else {
      compiledRoutes.push({
        route,
        compiledParams,
        argCount,
        requiresRequestScope: true,
        middlewareSpecs,
        guardSpecs,
        interceptorSpecs,
        sharedPipeSpecs,
        filterSpecs,
        hasCustomParam,
      });
    }
  }

  // Group routes by canonicalPath to classify native Bun.serve({ routes }) vs FallbackRadixRouter
  const groupedByCanonicalPath = new Map<string, CompiledRoute[]>();
  for (let i = 0; i < compiledRoutes.length; i++) {
    const item = compiledRoutes[i];
    if (!item) continue;
    let bucket = groupedByCanonicalPath.get(item.route.canonicalPath);
    if (!bucket) {
      bucket = [];
      groupedByCanonicalPath.set(item.route.canonicalPath, bucket);
    }
    bucket.push(item);
  }

  const bunRoutes: Record<
    string,
    (req: Request, server: BunServerLike) => Response | Promise<Response>
  > = {};
  const nativeMatcher = new NativePathMatcher<CompiledPathDispatcher>();
  const fallbackRouter = new FallbackRadixRouter(versioning);

  // Pre-scan all fallback routes so native `:param` or trailing `/*` routes
  // that structurally overlap a fallback route are demoted to FallbackRadixRouter.
  const fallbackRouteDescriptors: Array<{ path: string; hasHost: boolean }> =
    [];
  for (const group of groupedByCanonicalPath.values()) {
    const first = group[0];
    if (!first) continue;
    const isGroupNative = group.every(
      (item) =>
        item.route.isNativePathEligible &&
        item.route.fullPath === first.route.fullPath,
    );
    if (!isGroupNative) {
      for (const item of group) {
        fallbackRouteDescriptors.push({
          path: item.route.fullPath,
          hasHost: item.route.host !== undefined,
        });
      }
    }
  }

  const shadowsFallbackRoute = (nativePath: string): boolean => {
    if (fallbackRouteDescriptors.length === 0) {
      return false;
    }
    return fallbackRouteDescriptors.some((fb) =>
      canNativePathOverlapFallback(nativePath, fb.path, fb.hasHost),
    );
  };

  // Under runtime versioning (HEADER/MEDIA_TYPE/CUSTOM), a version miss on a more specific
  // route (e.g. `/items/me` @Version('2')) must fall through to a less specific route
  // (e.g. `/items/:id` @Version('1') or `/*`). Demote all routes into FallbackRadixRouter
  // whenever runtime versioning has both static/param/wildcard routes that can fall through.
  const hasDynamicVersionedRoutes =
    runtimeVersioning &&
    Array.from(groupedByCanonicalPath.values()).some((g) => {
      const p = g[0]?.route.fullPath ?? "";
      return p.includes(":") || p.includes("*");
    });

  for (const group of groupedByCanonicalPath.values()) {
    const first = group[0];
    if (!first) continue;

    const allNative =
      !hasDynamicVersionedRoutes &&
      !shadowsFallbackRoute(first.route.fullPath) &&
      group.every(
        (item) =>
          item.route.isNativePathEligible &&
          item.route.fullPath === first.route.fullPath,
      );

    if (!allNative) {
      for (const item of group) {
        fallbackRouter.addRoute(item);
      }
      continue;
    }

    const registeredPath = first.route.fullPath;
    const isStaticPath =
      !registeredPath.includes(":") && !registeredPath.includes("*");
    const staticPathname = isStaticPath ? registeredPath : undefined;
    const safeParamNames = hasOnlySafeNativeParamNames(registeredPath);

    if (runtimeVersioning && versioning) {
      // Native O(1) path dispatch with runtime API versioning (HEADER / MEDIA_TYPE / CUSTOM)
      const versionedMethods: Partial<
        Record<HttpMethod, VersionedCompiledGroup>
      > = {};
      let versionedAll: VersionedCompiledGroup | undefined;

      for (const item of group) {
        if (item.route.method === "ALL") {
          if (!versionedAll) {
            versionedAll = { byVersion: new Map() };
          }
          addCompiledToVersionGroup(versionedAll, item);
        } else {
          let vg = versionedMethods[item.route.method];
          if (!vg) {
            vg = { byVersion: new Map() };
            versionedMethods[item.route.method] = vg;
          }
          addCompiledToVersionGroup(vg, item);
        }
      }

      const fullAllowHeader = computeAllowHeader(
        versionedMethods,
        versionedAll !== undefined,
      );

      const dispatchPath: CompiledPathDispatcher = async (
        req: Request,
        server?: BunServerLike,
        overrideParams?: Record<string, string>,
      ): Promise<Response> => {
        const reqMethod = req.method as HttpMethod;
        const requestedVersions = extractRequestVersions(req, versioning);

        const matched =
          matchCompiledVersionGroup(
            versionedMethods[reqMethod],
            requestedVersions,
          ) ??
          (reqMethod === "HEAD"
            ? matchCompiledVersionGroup(versionedMethods.GET, requestedVersions)
            : undefined) ??
          matchCompiledVersionGroup(versionedAll, requestedVersions);

        if (matched) {
          const nativeParams = isStaticPath
            ? undefined
            : (overrideParams ??
              (req as Request & { params?: Record<string, string> }).params);
          const ctx = new RequestContext({
            request: req,
            server,
            params: nativeParams,
            paramsPreSanitized: safeParamNames,
            pathname: staticPathname,
            trustProxy,
            maxBodyBytes: bodyLimit,
            bodyParser,
            captureRawBody: rawBody,
            multipart,
            cookieSecrets,
          });
          const versionAllow =
            computeAllowHeaderForVersion(
              versionedMethods,
              versionedAll,
              requestedVersions,
            ) || fullAllowHeader;
          return executeCompiledRoute(matched, ctx, runtime, versionAllow);
        }

        // CORS preflight shortcut
        if (
          reqMethod === "OPTIONS" &&
          runtime.cors &&
          isCorsPreflightRequest(req)
        ) {
          const versionAllow =
            computeAllowHeaderForVersion(
              versionedMethods,
              versionedAll,
              requestedVersions,
            ) || fullAllowHeader;
          const corsResult = await evaluateCors(
            req,
            runtime.cors,
            versionAllow,
          );
          if (!runtime.cors.preflightContinue) {
            return securityHeaders
              ? applySecurityHeaders(
                  createPreflightResponse(corsResult, runtime.cors),
                  securityHeaders,
                )
              : createPreflightResponse(corsResult, runtime.cors);
          }
        }

        const versionAllow = computeAllowHeaderForVersion(
          versionedMethods,
          versionedAll,
          requestedVersions,
        );

        const ctx = new RequestContext({
          request: req,
          server,
          pathname: staticPathname,
          trustProxy,
          maxBodyBytes: bodyLimit,
          bodyParser,
          captureRawBody: rawBody,
          multipart,
          cookieSecrets,
        });

        // If another HTTP verb exists for the requested version -> 405; otherwise 404 (version not found)
        if (versionAllow.length > 0) {
          return executeFallbackException(
            new MethodNotAllowedException(
              `Method ${reqMethod} not allowed for ${ctx.pathname}`,
              { headers: { Allow: versionAllow } },
            ),
            ctx,
            runtime,
            versionAllow,
          );
        }

        return executeFallbackException(
          new NotFoundException(`Cannot ${req.method} ${ctx.pathname}`),
          ctx,
          runtime,
        );
      };

      bunRoutes[registeredPath] = (req, server) => dispatchPath(req, server);
      nativeMatcher.add(registeredPath, dispatchPath);
      continue;
    }

    // Standard (unversioned or URI-versioned) native path dispatcher
    const methods: Partial<Record<HttpMethod, CompiledRoute>> = {};
    let allHandler: CompiledRoute | undefined;

    for (const item of group) {
      if (item.route.method === "ALL") {
        allHandler = item;
      } else {
        methods[item.route.method] = item;
      }
    }

    const allowHeader = computeAllowHeader(methods, allHandler !== undefined);
    const singleMethodOnly =
      group.length === 1 && !allHandler ? group[0]! : undefined;

    let dispatchPath: CompiledPathDispatcher;

    if (singleMethodOnly) {
      const targetMethod = singleMethodOnly.route.method as HttpMethod;
      const allowImplicitHead = targetMethod === "GET";

      dispatchPath = (
        req: Request,
        server?: BunServerLike,
        overrideParams?: Record<string, string>,
      ): Response | Promise<Response> => {
        const m = req.method;
        if (m === targetMethod || (allowImplicitHead && m === "HEAD")) {
          const nativeParams = isStaticPath
            ? undefined
            : (overrideParams ??
              (req as Request & { params?: Record<string, string> }).params);
          const ctx = new RequestContext({
            request: req,
            server,
            params: nativeParams,
            paramsPreSanitized: safeParamNames,
            pathname: staticPathname,
            trustProxy,
            maxBodyBytes: bodyLimit,
            bodyParser,
            captureRawBody: rawBody,
            multipart,
            cookieSecrets,
          });
          return executeCompiledRoute(
            singleMethodOnly,
            ctx,
            runtime,
            allowHeader,
          );
        }

        const upperMethod = m.toUpperCase() as HttpMethod;
        if (
          upperMethod === targetMethod ||
          (allowImplicitHead && upperMethod === "HEAD")
        ) {
          const nativeParams = isStaticPath
            ? undefined
            : (overrideParams ??
              (req as Request & { params?: Record<string, string> }).params);
          const ctx = new RequestContext({
            request: req,
            server,
            params: nativeParams,
            paramsPreSanitized: safeParamNames,
            pathname: staticPathname,
            trustProxy,
            maxBodyBytes: bodyLimit,
            bodyParser,
            captureRawBody: rawBody,
            multipart,
            cookieSecrets,
          });
          return executeCompiledRoute(
            singleMethodOnly,
            ctx,
            runtime,
            allowHeader,
          );
        }

        if (
          upperMethod === "OPTIONS" &&
          runtime.cors &&
          isCorsPreflightRequest(req)
        ) {
          return evaluateCors(req, runtime.cors, allowHeader).then(
            (corsResult) => {
              if (!runtime.cors!.preflightContinue) {
                return securityHeaders
                  ? applySecurityHeaders(
                      createPreflightResponse(corsResult, runtime.cors!),
                      securityHeaders,
                    )
                  : createPreflightResponse(corsResult, runtime.cors!);
              }
              const ctx = new RequestContext({
                request: req,
                server,
                pathname: staticPathname,
                trustProxy,
                maxBodyBytes: bodyLimit,
                captureRawBody: rawBody,
                multipart,
              });
              return executeFallbackException(
                new MethodNotAllowedException(
                  `Method ${upperMethod} not allowed for ${ctx.pathname}`,
                  { headers: { Allow: allowHeader } },
                ),
                ctx,
                runtime,
                allowHeader,
              );
            },
          );
        }

        const ctx = new RequestContext({
          request: req,
          server,
          pathname: staticPathname,
          trustProxy,
          maxBodyBytes: bodyLimit,
          bodyParser,
          captureRawBody: rawBody,
          multipart,
          cookieSecrets,
        });
        return executeFallbackException(
          new MethodNotAllowedException(
            `Method ${upperMethod} not allowed for ${ctx.pathname}`,
            { headers: { Allow: allowHeader } },
          ),
          ctx,
          runtime,
          allowHeader,
        );
      };
    } else {
      dispatchPath = (
        req: Request,
        server?: BunServerLike,
        overrideParams?: Record<string, string>,
      ): Response | Promise<Response> => {
        const rawMethod = req.method as HttpMethod;
        let matched =
          methods[rawMethod] ??
          (rawMethod === "HEAD" ? methods.GET : undefined) ??
          allHandler;

        let reqMethod = rawMethod;
        if (!matched) {
          reqMethod = req.method.toUpperCase() as HttpMethod;
          if (reqMethod !== rawMethod) {
            matched =
              methods[reqMethod] ??
              (reqMethod === "HEAD" ? methods.GET : undefined) ??
              allHandler;
          }
        }

        if (matched) {
          const nativeParams = isStaticPath
            ? undefined
            : (overrideParams ??
              (req as Request & { params?: Record<string, string> }).params);
          const ctx = new RequestContext({
            request: req,
            server,
            params: nativeParams,
            paramsPreSanitized: safeParamNames,
            pathname: staticPathname,
            trustProxy,
            maxBodyBytes: bodyLimit,
            bodyParser,
            captureRawBody: rawBody,
            multipart,
            cookieSecrets,
          });
          return executeCompiledRoute(matched, ctx, runtime, allowHeader);
        }

        // Per-path CORS preflight OPTIONS shortcut (ADR-011 §1 & §2)
        if (
          reqMethod === "OPTIONS" &&
          runtime.cors &&
          isCorsPreflightRequest(req)
        ) {
          return evaluateCors(req, runtime.cors, allowHeader).then(
            (corsResult) => {
              if (!runtime.cors!.preflightContinue) {
                return securityHeaders
                  ? applySecurityHeaders(
                      createPreflightResponse(corsResult, runtime.cors!),
                      securityHeaders,
                    )
                  : createPreflightResponse(corsResult, runtime.cors!);
              }
              const ctx = new RequestContext({
                request: req,
                server,
                pathname: staticPathname,
                trustProxy,
                maxBodyBytes: bodyLimit,
                captureRawBody: rawBody,
                multipart,
              });
              return executeFallbackException(
                new MethodNotAllowedException(
                  `Method ${reqMethod} not allowed for ${ctx.pathname}`,
                  { headers: { Allow: allowHeader } },
                ),
                ctx,
                runtime,
                allowHeader,
              );
            },
          );
        }

        // Unmatched HTTP method on a matched path -> 405 Method Not Allowed + Allow header
        const ctx = new RequestContext({
          request: req,
          server,
          pathname: staticPathname,
          trustProxy,
          maxBodyBytes: bodyLimit,
          bodyParser,
          captureRawBody: rawBody,
          multipart,
          cookieSecrets,
        });
        return executeFallbackException(
          new MethodNotAllowedException(
            `Method ${reqMethod} not allowed for ${ctx.pathname}`,
            { headers: { Allow: allowHeader } },
          ),
          ctx,
          runtime,
          allowHeader,
        );
      };
    }

    bunRoutes[registeredPath] = (req, server) => dispatchPath(req, server);
    nativeMatcher.add(registeredPath, dispatchPath);
  }

  const publicRoutes: RouteDefinition[] = compiledRoutes.map(({ route }) => ({
    method: route.method,
    path: route.path,
    fullPath: route.fullPath,
    controller: route.controller,
    controllerToken: route.controllerToken,
    handlerKey: route.handlerKey,
    parameters: route.parameters,
    httpCode: route.httpCode,
    headers: route.headers,
    redirect: route.redirect,
    renderTemplate: route.renderTemplate,
    isSse: route.isSse,
    sseOptions: route.sseOptions,
    version: route.version,
  }));

  return {
    routes: publicRoutes,
    compiledRoutes,
    bunRoutes,
    nativeMatcher,
    fallbackRouter,
    runtime,
  };
}
