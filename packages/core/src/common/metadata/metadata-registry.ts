import "./reflect-shim";
import {
  DESIGN_METADATA_KEYS,
  METADATA_KEYS,
  type MetadataKey,
} from "../constants/metadata-keys";
import type { RouteHttpMethod, Scope } from "../enums/scope.enum";
import type {
  ControllerMetadata,
  HeaderMetadata,
  ParameterMetadata,
  PipeLike,
  RedirectMetadata,
  RouteMethodMetadata,
  SseOptions,
} from "../interfaces/http.interface";
import type {
  ExceptionFilterLike,
  GuardLike,
  InterceptorLike,
  MiddlewareLike,
} from "../interfaces/pipeline.interface";
import type {
  InjectTokenMetadata,
  PropertyInjectMetadata,
} from "../interfaces/provider.interface";
import type { VersionValue } from "../interfaces/versioning.interface";

export interface PrecompiledRouteDescriptor {
  readonly method: RouteHttpMethod;
  readonly path: string | string[];
  readonly paths: readonly string[];
  readonly handlerKey: string | symbol;
  readonly handlerFn: Function | undefined;
  readonly parameters: readonly ParameterMetadata[];
  readonly httpCode?: number;
  readonly headers: readonly HeaderMetadata[];
  readonly redirect?: RedirectMetadata;
  readonly renderTemplate?: string;
  readonly isSse: boolean;
  readonly sseOptions?: SseOptions;
  readonly methodVersion?: VersionValue;
  readonly methodMiddlewares: readonly MiddlewareLike[];
  readonly methodGuards: readonly GuardLike[];
  readonly methodPipes: readonly PipeLike[];
  readonly methodInterceptors: readonly InterceptorLike[];
  readonly methodFilters: readonly ExceptionFilterLike[];
}

export interface PrecompiledControllerDescriptor {
  readonly controller: Function;
  readonly metadata: ControllerMetadata;
  readonly paths: readonly string[];
  readonly host?: string | RegExp | Array<string | RegExp>;
  readonly scope?: Scope;
  readonly durable?: boolean;
  readonly controllerVersion?: VersionValue;
  readonly controllerMiddlewares: readonly MiddlewareLike[];
  readonly controllerGuards: readonly GuardLike[];
  readonly controllerPipes: readonly PipeLike[];
  readonly controllerInterceptors: readonly InterceptorLike[];
  readonly controllerFilters: readonly ExceptionFilterLike[];
  readonly routes: readonly PrecompiledRouteDescriptor[];
}

interface WatchedTargetEpoch {
  readonly target: object;
  readonly epoch: number;
}

interface CachedControllerEntry {
  readonly descriptor: PrecompiledControllerDescriptor;
  readonly watched: readonly WatchedTargetEpoch[];
}

const NON_INHERITED_CUSTOM_METHOD_KEYS = new Set<MetadataKey>([
  METADATA_KEYS.GUARDS,
  METADATA_KEYS.PIPES,
  METADATA_KEYS.INTERCEPTORS,
  METADATA_KEYS.EXCEPTION_FILTERS,
  METADATA_KEYS.MIDDLEWARES,
  METADATA_KEYS.ROUTE_METHOD,
  METADATA_KEYS.ROUTE_PATH,
  METADATA_KEYS.HTTP_CODE,
  METADATA_KEYS.HEADERS,
  METADATA_KEYS.REDIRECT,
  METADATA_KEYS.RENDER,
  METADATA_KEYS.SSE,
  METADATA_KEYS.SSE_OPTIONS,
  METADATA_KEYS.VERSION,
  METADATA_KEYS.INHERIT_METHOD_ENHANCERS,
  DESIGN_METADATA_KEYS.TYPE,
  DESIGN_METADATA_KEYS.PARAMTYPES,
  DESIGN_METADATA_KEYS.RETURNTYPE,
]);

function normalizePathStrings(value: string | readonly string[]): string[] {
  if (Array.isArray(value)) {
    return value.length > 0 ? [...value] : [""];
  }
  return [value as string];
}

/**
 * Isolated metadata registry decoupling Bunest from direct Reflect calls
 * and providing inheritance-safe (copy-on-write) metadata helpers plus
 * automatic WeakMap-cached controller route/enhancer pre-indexing.
 */
export class MetadataRegistry {
  private static nextMutationEpoch = 1;
  private static readonly targetEpochs = new WeakMap<object, number>();
  private static controllerCache = new WeakMap<
    Function,
    CachedControllerEntry
  >();

  private static markMutated(target: object): void {
    const epoch = ++MetadataRegistry.nextMutationEpoch;
    MetadataRegistry.targetEpochs.set(target, epoch);
    if (typeof target === "function") {
      MetadataRegistry.controllerCache.delete(target);
    } else if (typeof target === "object" && target !== null) {
      const ctor = (target as { constructor?: unknown }).constructor;
      if (typeof ctor === "function") {
        MetadataRegistry.targetEpochs.set(ctor, epoch);
        MetadataRegistry.controllerCache.delete(ctor);
      }
    }
  }

  static define<T = unknown>(
    key: MetadataKey,
    value: T,
    target: object,
    propertyKey?: string | symbol,
  ): void {
    if (propertyKey !== undefined) {
      Reflect.defineMetadata(key, value, target, propertyKey);
    } else {
      Reflect.defineMetadata(key, value, target);
    }
    MetadataRegistry.markMutated(target);
  }

  static get<T = unknown>(
    key: MetadataKey,
    target: object,
    propertyKey?: string | symbol,
  ): T | undefined {
    if (propertyKey !== undefined) {
      return Reflect.getMetadata(key, target, propertyKey) as T | undefined;
    }
    return Reflect.getMetadata(key, target) as T | undefined;
  }

  static getOwn<T = unknown>(
    key: MetadataKey,
    target: object,
    propertyKey?: string | symbol,
  ): T | undefined {
    if (propertyKey !== undefined) {
      return Reflect.getOwnMetadata(key, target, propertyKey) as T | undefined;
    }
    return Reflect.getOwnMetadata(key, target) as T | undefined;
  }

  static has(
    key: MetadataKey,
    target: object,
    propertyKey?: string | symbol,
  ): boolean {
    if (propertyKey !== undefined) {
      return Reflect.hasMetadata(key, target, propertyKey);
    }
    return Reflect.hasMetadata(key, target);
  }

  static hasOwn(
    key: MetadataKey,
    target: object,
    propertyKey?: string | symbol,
  ): boolean {
    if (propertyKey !== undefined) {
      return Reflect.hasOwnMetadata(key, target, propertyKey);
    }
    return Reflect.hasOwnMetadata(key, target);
  }

  static delete(
    key: MetadataKey,
    target: object,
    propertyKey?: string | symbol,
  ): boolean {
    const deleted =
      propertyKey !== undefined
        ? Reflect.deleteMetadata(key, target, propertyKey)
        : Reflect.deleteMetadata(key, target);
    if (deleted) {
      MetadataRegistry.markMutated(target);
    }
    return deleted;
  }

  static getKeys(target: object, propertyKey?: string | symbol): MetadataKey[] {
    if (propertyKey !== undefined) {
      return Reflect.getMetadataKeys(target, propertyKey) as MetadataKey[];
    }
    return Reflect.getMetadataKeys(target) as MetadataKey[];
  }

  static getOwnKeys(
    target: object,
    propertyKey?: string | symbol,
  ): MetadataKey[] {
    if (propertyKey !== undefined) {
      return Reflect.getOwnMetadataKeys(target, propertyKey) as MetadataKey[];
    }
    return Reflect.getOwnMetadataKeys(target) as MetadataKey[];
  }

  /**
   * Copies all own metadata keys from `source` to `target` without overwriting
   * keys already defined directly on `target`.
   * Preserves route/enhancer/custom metadata when wrapping method functions.
   */
  static copyMetadata(source: object, target: object): void {
    if (!source || !target || source === target) {
      return;
    }
    const keys = MetadataRegistry.getOwnKeys(source);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      if (!MetadataRegistry.hasOwn(key, target)) {
        MetadataRegistry.define(
          key,
          MetadataRegistry.getOwn(key, source),
          target,
        );
      }
    }
  }

  /**
   * Copy-on-write prepend to an own array metadata entry.
   * Never reads or mutates parent prototype metadata.
   * Prepending preserves top-to-bottom declaration order for stacked legacy decorators.
   */
  static prependOwnArray<T>(
    key: MetadataKey,
    items: readonly T[],
    target: object,
    propertyKey?: string | symbol,
  ): T[] {
    const existing = MetadataRegistry.getOwn<readonly T[]>(
      key,
      target,
      propertyKey,
    );
    const next = existing ? [...items, ...existing] : [...items];
    MetadataRegistry.define(key, next, target, propertyKey);
    return next;
  }

  /**
   * Copy-on-write append to an own array metadata entry.
   * Never reads or mutates parent prototype metadata.
   */
  static appendOwnArray<T>(
    key: MetadataKey,
    items: readonly T[],
    target: object,
    propertyKey?: string | symbol,
  ): T[] {
    const existing = MetadataRegistry.getOwn<readonly T[]>(
      key,
      target,
      propertyKey,
    );
    const next = existing ? [...existing, ...items] : [...items];
    MetadataRegistry.define(key, next, target, propertyKey);
    return next;
  }

  /**
   * Returns class hierarchy from base class to derived class.
   */
  static getPrototypeChain(target: Function): Function[] {
    const chain: Function[] = [];
    let current: unknown = target;
    while (
      typeof current === "function" &&
      current !== Function.prototype &&
      current !== Object
    ) {
      chain.unshift(current);
      current = Object.getPrototypeOf(current);
    }
    return chain;
  }

  /**
   * Collects own array metadata across the class inheritance chain (base -> derived)
   * without mutating any parent arrays.
   */
  static getMergedClassArray<T>(key: MetadataKey, target: Function): T[] {
    const result: T[] = [];
    for (const ctor of MetadataRegistry.getPrototypeChain(target)) {
      const own = MetadataRegistry.getOwn<readonly T[]>(key, ctor);
      if (own && own.length > 0) {
        result.push(...own);
      }
    }
    return result;
  }

  /**
   * Inheritance-safe prototype-chain method metadata merger.
   * Collects own array metadata stored on constructors along the inheritance chain
   * (base -> derived), grouping entries by `keyProp` (defaulting to `"methodName"`
   * or `"handlerKey"` when present on object items). Subclass definitions for the
   * same method key replace parent definitions for that key without mutating parent
   * metadata.
   */
  static getMergedMethodArray<T>(
    key: MetadataKey,
    target: object,
    keyProp?: keyof T,
  ): T[] {
    const ctor =
      typeof target === "function"
        ? target
        : (target as { constructor?: Function }).constructor;
    if (typeof ctor !== "function") {
      return [];
    }

    const chain = MetadataRegistry.getPrototypeChain(ctor);
    const orderedKeys: unknown[] = [];
    const byKey = new Map<unknown, T[]>();

    for (const cls of chain) {
      const own = MetadataRegistry.getOwn<readonly T[]>(key, cls);
      if (!own || own.length === 0) {
        continue;
      }

      const groupedOwn = new Map<unknown, T[]>();
      for (const item of own) {
        let groupKey: unknown;
        if (keyProp !== undefined) {
          groupKey = item[keyProp];
        } else if (typeof item === "object" && item !== null) {
          if ("methodName" in item) {
            groupKey = (item as Record<string, unknown>).methodName;
          } else if ("handlerKey" in item) {
            groupKey = (item as Record<string, unknown>).handlerKey;
          } else {
            groupKey = Symbol();
          }
        } else {
          groupKey = Symbol();
        }

        let bucket = groupedOwn.get(groupKey);
        if (!bucket) {
          bucket = [];
          groupedOwn.set(groupKey, bucket);
        }
        bucket.push(
          typeof item === "object" && item !== null ? { ...item } : item,
        );
      }

      for (const [groupKey, entries] of groupedOwn.entries()) {
        if (!byKey.has(groupKey)) {
          orderedKeys.push(groupKey);
        }
        byKey.set(groupKey, entries);
      }
    }

    const result: T[] = [];
    for (const groupKey of orderedKeys) {
      const entries = byKey.get(groupKey);
      if (entries) {
        result.push(...entries);
      }
    }
    return result;
  }

  // --- TypeScript design:* metadata helpers ---

  static getParamTypes(
    target: object,
    propertyKey?: string | symbol,
  ): Function[] | undefined {
    return MetadataRegistry.get<Function[]>(
      DESIGN_METADATA_KEYS.PARAMTYPES,
      target,
      propertyKey,
    );
  }

  static getType(
    target: object,
    propertyKey?: string | symbol,
  ): Function | undefined {
    return MetadataRegistry.get<Function>(
      DESIGN_METADATA_KEYS.TYPE,
      target,
      propertyKey,
    );
  }

  static getReturnType(
    target: object,
    propertyKey?: string | symbol,
  ): Function | undefined {
    return MetadataRegistry.get<Function>(
      DESIGN_METADATA_KEYS.RETURNTYPE,
      target,
      propertyKey,
    );
  }

  // --- High-level Bunest metadata readers ---

  /**
   * Reads effective routes for a controller class across its inheritance hierarchy.
   * Subclass route definitions on the same handlerKey override parent route definitions
   * without mutating parent metadata.
   */
  static getControllerRoutes(controller: Function): RouteMethodMetadata[] {
    return MetadataRegistry.getMergedMethodArray<RouteMethodMetadata>(
      METADATA_KEYS.ROUTES,
      controller,
      "handlerKey",
    );
  }

  /**
   * Reads parameter metadata for a controller method, sorted ascending by parameter index,
   * enriched with `design:paramtypes` runtime metatype when available.
   * Walks prototypes to find the defining prototype for `handlerKey` and reads ONLY own
   * metadata from that prototype so overridden methods never leak parent parameter metadata.
   */
  static getRouteParameters(
    controller: Function,
    handlerKey: string | symbol,
  ): ParameterMetadata[] {
    let proto: object | null = (controller.prototype as object | null) ?? null;
    let definingProto: object | null = null;

    while (proto && proto !== Object.prototype) {
      if (Object.prototype.hasOwnProperty.call(proto, handlerKey)) {
        definingProto = proto;
        break;
      }
      proto = Object.getPrototypeOf(proto) as object | null;
    }

    if (!definingProto) {
      return [];
    }

    const rawParams =
      MetadataRegistry.getOwn<readonly ParameterMetadata[]>(
        METADATA_KEYS.ROUTE_PARAMS,
        definingProto,
        handlerKey,
      ) ?? [];

    const paramTypes = MetadataRegistry.getOwn<Function[]>(
      DESIGN_METADATA_KEYS.PARAMTYPES,
      definingProto,
      handlerKey,
    );

    return rawParams
      .map((param) => ({
        ...param,
        metatype: param.metatype ?? paramTypes?.[param.index],
      }))
      .sort((a, b) => a.index - b.index);
  }

  static getInjectTokens(target: Function): InjectTokenMetadata[] {
    const hasOwnCtor =
      MetadataRegistry.hasOwn(DESIGN_METADATA_KEYS.PARAMTYPES, target) ||
      MetadataRegistry.hasOwn(METADATA_KEYS.INJECT_TOKENS, target);

    const tokens =
      (hasOwnCtor
        ? MetadataRegistry.getOwn<readonly InjectTokenMetadata[]>(
            METADATA_KEYS.INJECT_TOKENS,
            target,
          )
        : MetadataRegistry.get<readonly InjectTokenMetadata[]>(
            METADATA_KEYS.INJECT_TOKENS,
            target,
          )) ?? [];

    return [...tokens].sort((a, b) => a.index - b.index);
  }

  static getOptionalDeps(target: Function): number[] {
    const hasOwnCtor =
      MetadataRegistry.hasOwn(DESIGN_METADATA_KEYS.PARAMTYPES, target) ||
      MetadataRegistry.hasOwn(METADATA_KEYS.OPTIONAL_DEPS, target);

    const indices =
      (hasOwnCtor
        ? MetadataRegistry.getOwn<readonly number[]>(
            METADATA_KEYS.OPTIONAL_DEPS,
            target,
          )
        : MetadataRegistry.get<readonly number[]>(
            METADATA_KEYS.OPTIONAL_DEPS,
            target,
          )) ?? [];

    return [...indices].sort((a, b) => a - b);
  }

  static getPropertyInjectTokens(target: Function): PropertyInjectMetadata[] {
    const merged = new Map<string | symbol, PropertyInjectMetadata>();
    for (const ctor of MetadataRegistry.getPrototypeChain(target)) {
      const own = MetadataRegistry.getOwn<readonly PropertyInjectMetadata[]>(
        METADATA_KEYS.PROPERTY_INJECT_TOKENS,
        ctor,
      );
      if (own) {
        for (const item of own) {
          merged.set(item.propertyKey, item);
        }
      }
    }
    return [...merged.values()];
  }

  static getOptionalPropertyDeps(target: Function): Array<string | symbol> {
    const set = new Set<string | symbol>();
    for (const ctor of MetadataRegistry.getPrototypeChain(target)) {
      const own = MetadataRegistry.getOwn<readonly (string | symbol)[]>(
        METADATA_KEYS.OPTIONAL_PROPERTY_DEPS,
        ctor,
      );
      if (own) {
        for (const prop of own) {
          set.add(prop);
        }
      }
    }
    return [...set];
  }

  static getHeaders(handler: Function): HeaderMetadata[] {
    const headers =
      MetadataRegistry.get<readonly HeaderMetadata[]>(
        METADATA_KEYS.HEADERS,
        handler,
      ) ?? [];
    return headers.map((h) => ({ ...h }));
  }

  /**
   * Invalidates the cached `PrecompiledControllerDescriptor` for one controller
   * (or resets the entire WeakMap cache when called without arguments).
   */
  static invalidateControllerCache(controller?: Function): void {
    if (controller) {
      MetadataRegistry.controllerCache.delete(controller);
    } else {
      MetadataRegistry.controllerCache = new WeakMap<
        Function,
        CachedControllerEntry
      >();
    }
  }

  /**
   * Builds and caches a normalized `PrecompiledControllerDescriptor` (routes,
   * parameters, response metadata, versioning, controller & inherited method
   * enhancers) on a `WeakMap<Function, ...>` that invalidates automatically
   * whenever any watched class, prototype, or handler metadata changes.
   */
  static precompileController(
    controller: Function,
  ): PrecompiledControllerDescriptor | undefined {
    const controllerMeta = MetadataRegistry.get<ControllerMetadata>(
      METADATA_KEYS.CONTROLLER,
      controller,
    );
    if (!controllerMeta) {
      return undefined;
    }

    const chain = MetadataRegistry.getPrototypeChain(controller);
    const controllerPaths = normalizePathStrings(controllerMeta.path);
    const controllerVersion =
      MetadataRegistry.get<VersionValue>(METADATA_KEYS.VERSION, controller) ??
      controllerMeta.version;

    const controllerMiddlewares =
      MetadataRegistry.getMergedClassArray<MiddlewareLike>(
        METADATA_KEYS.MIDDLEWARES,
        controller,
      );
    const controllerGuards = MetadataRegistry.getMergedClassArray<GuardLike>(
      METADATA_KEYS.GUARDS,
      controller,
    );
    const controllerPipes = MetadataRegistry.getMergedClassArray<PipeLike>(
      METADATA_KEYS.PIPES,
      controller,
    );
    const controllerInterceptors =
      MetadataRegistry.getMergedClassArray<InterceptorLike>(
        METADATA_KEYS.INTERCEPTORS,
        controller,
      );
    const controllerFilters =
      MetadataRegistry.getMergedClassArray<ExceptionFilterLike>(
        METADATA_KEYS.EXCEPTION_FILTERS,
        controller,
      );

    const routeMethods = MetadataRegistry.getControllerRoutes(controller);
    const proto = controller.prototype as
      Record<string | symbol, unknown> | undefined;

    const watchedSet = new Set<object>();
    for (let i = 0; i < chain.length; i++) {
      watchedSet.add(chain[i]!);
    }

    const routes: PrecompiledRouteDescriptor[] = [];

    for (let i = 0; i < routeMethods.length; i++) {
      const routeMeta = routeMethods[i]!;
      const handlerCandidate = proto?.[routeMeta.handlerKey];
      const handlerFn =
        typeof handlerCandidate === "function"
          ? (handlerCandidate as Function)
          : undefined;

      if (!handlerFn) {
        routes.push({
          method: routeMeta.method,
          path: routeMeta.path,
          paths: normalizePathStrings(routeMeta.path),
          handlerKey: routeMeta.handlerKey,
          handlerFn: undefined,
          parameters: [],
          headers: [],
          isSse: routeMeta.isSse === true,
          ...(routeMeta.sseOptions !== undefined
            ? { sseOptions: routeMeta.sseOptions }
            : {}),
          methodMiddlewares: [],
          methodGuards: [],
          methodPipes: [],
          methodInterceptors: [],
          methodFilters: [],
        });
        continue;
      }

      const methodChain = collectInheritedMethodChain(
        chain,
        routeMeta.handlerKey,
      );
      inheritMissingCustomMethodMetadata(methodChain, handlerFn);

      watchedSet.add(handlerFn);
      for (let m = 0; m < methodChain.length; m++) {
        watchedSet.add(methodChain[m]!);
      }

      const parameters = MetadataRegistry.getRouteParameters(
        controller,
        routeMeta.handlerKey,
      );
      const httpCode = MetadataRegistry.get<number>(
        METADATA_KEYS.HTTP_CODE,
        handlerFn,
      );
      const headers = MetadataRegistry.getHeaders(handlerFn);
      const redirect = MetadataRegistry.get<RedirectMetadata>(
        METADATA_KEYS.REDIRECT,
        handlerFn,
      );
      const renderTemplate = MetadataRegistry.get<string>(
        METADATA_KEYS.RENDER,
        handlerFn,
      );
      const isSse =
        routeMeta.isSse === true ||
        MetadataRegistry.get<boolean>(METADATA_KEYS.SSE, handlerFn) === true;
      const sseOptions =
        routeMeta.sseOptions ??
        MetadataRegistry.get<SseOptions>(METADATA_KEYS.SSE_OPTIONS, handlerFn);
      const methodVersion = MetadataRegistry.get<VersionValue>(
        METADATA_KEYS.VERSION,
        handlerFn,
      );

      const methodMiddlewares = mergeInheritedMethodEnhancers<MiddlewareLike>(
        METADATA_KEYS.MIDDLEWARES,
        methodChain,
        handlerFn,
      );
      const methodGuards = mergeInheritedMethodEnhancers<GuardLike>(
        METADATA_KEYS.GUARDS,
        methodChain,
        handlerFn,
      );
      const methodPipes = mergeInheritedMethodEnhancers<PipeLike>(
        METADATA_KEYS.PIPES,
        methodChain,
        handlerFn,
      );
      const methodInterceptors = mergeInheritedMethodEnhancers<InterceptorLike>(
        METADATA_KEYS.INTERCEPTORS,
        methodChain,
        handlerFn,
      );
      const methodFilters = mergeInheritedMethodEnhancers<ExceptionFilterLike>(
        METADATA_KEYS.EXCEPTION_FILTERS,
        methodChain,
        handlerFn,
      );

      routes.push({
        method: routeMeta.method,
        path: routeMeta.path,
        paths: normalizePathStrings(routeMeta.path),
        handlerKey: routeMeta.handlerKey,
        handlerFn,
        parameters,
        ...(httpCode !== undefined ? { httpCode } : {}),
        headers,
        ...(redirect !== undefined ? { redirect } : {}),
        ...(renderTemplate !== undefined ? { renderTemplate } : {}),
        isSse,
        ...(sseOptions !== undefined ? { sseOptions } : {}),
        ...(methodVersion !== undefined ? { methodVersion } : {}),
        methodMiddlewares,
        methodGuards,
        methodPipes,
        methodInterceptors,
        methodFilters,
      });
    }

    const descriptor: PrecompiledControllerDescriptor = {
      controller,
      metadata: controllerMeta,
      paths: controllerPaths,
      ...(controllerMeta.host !== undefined
        ? { host: controllerMeta.host }
        : {}),
      ...(controllerMeta.scope !== undefined
        ? { scope: controllerMeta.scope }
        : {}),
      ...(controllerMeta.durable !== undefined
        ? { durable: controllerMeta.durable }
        : {}),
      ...(controllerVersion !== undefined ? { controllerVersion } : {}),
      controllerMiddlewares,
      controllerGuards,
      controllerPipes,
      controllerInterceptors,
      controllerFilters,
      routes,
    };

    const watched: WatchedTargetEpoch[] = [];
    for (const watchedTarget of watchedSet) {
      watched.push({
        target: watchedTarget,
        epoch: MetadataRegistry.targetEpochs.get(watchedTarget) ?? 0,
      });
    }

    MetadataRegistry.controllerCache.set(controller, {
      descriptor,
      watched,
    });

    return descriptor;
  }

  /**
   * Returns a cached `PrecompiledControllerDescriptor` if still valid, or
   * compiles and caches it on demand. Automatically invalidates whenever any
   * watched class, ancestor, prototype, or handler metadata has changed.
   */
  static getPrecompiledController(
    controller: Function,
  ): PrecompiledControllerDescriptor | undefined {
    const cached = MetadataRegistry.controllerCache.get(controller);
    if (cached) {
      let valid = true;
      const watched = cached.watched;
      for (let i = 0; i < watched.length; i++) {
        const entry = watched[i]!;
        if (
          (MetadataRegistry.targetEpochs.get(entry.target) ?? 0) !== entry.epoch
        ) {
          valid = false;
          break;
        }
      }
      if (valid) {
        return cached.descriptor;
      }
    }
    return MetadataRegistry.precompileController(controller);
  }
}

function collectInheritedMethodChain(
  chain: readonly Function[],
  handlerKey: string | symbol,
): Function[] {
  const methods: Function[] = [];

  for (let i = 0; i < chain.length; i++) {
    const cls = chain[i]!;
    if (
      MetadataRegistry.getOwn<boolean>(
        METADATA_KEYS.INHERIT_METHOD_ENHANCERS,
        cls,
      ) === false
    ) {
      methods.length = 0;
    }

    const proto = cls.prototype as Record<string | symbol, unknown> | undefined;
    if (!proto || !Object.prototype.hasOwnProperty.call(proto, handlerKey)) {
      continue;
    }

    const candidate = proto[handlerKey];
    if (typeof candidate !== "function") {
      continue;
    }

    if (
      MetadataRegistry.getOwn<boolean>(
        METADATA_KEYS.INHERIT_METHOD_ENHANCERS,
        candidate,
      ) === false
    ) {
      methods.length = 0;
    }

    methods.push(candidate);
  }

  return methods;
}

function mergeInheritedMethodEnhancers<T>(
  key: MetadataKey,
  methodChain: readonly Function[],
  fallbackHandler: Function,
): T[] {
  if (methodChain.length === 0) {
    const direct = MetadataRegistry.get<readonly T[]>(key, fallbackHandler);
    return direct ? [...direct] : [];
  }
  if (methodChain.length === 1) {
    const own = MetadataRegistry.get<readonly T[]>(key, methodChain[0]!);
    return own ? [...own] : [];
  }

  const merged: T[] = [];
  for (let i = 0; i < methodChain.length; i++) {
    const own = MetadataRegistry.getOwn<readonly T[]>(key, methodChain[i]!);
    if (own && own.length > 0) {
      merged.push(...own);
    }
  }
  return merged;
}

function inheritMissingCustomMethodMetadata(
  methodChain: readonly Function[],
  derivedHandler: Function,
): void {
  if (methodChain.length <= 1) {
    return;
  }

  for (let i = methodChain.length - 2; i >= 0; i--) {
    const parentFn = methodChain[i]!;
    if (parentFn === derivedHandler) {
      continue;
    }
    const keys = MetadataRegistry.getOwnKeys(parentFn);
    for (let j = 0; j < keys.length; j++) {
      const key = keys[j]!;
      if (
        !NON_INHERITED_CUSTOM_METHOD_KEYS.has(key) &&
        !MetadataRegistry.hasOwn(key, derivedHandler)
      ) {
        MetadataRegistry.define(
          key,
          MetadataRegistry.getOwn(key, parentFn),
          derivedHandler,
        );
      }
    }
  }
}

export function precompileController(
  controller: Function,
): PrecompiledControllerDescriptor | undefined {
  return MetadataRegistry.precompileController(controller);
}

export function getPrecompiledController(
  controller: Function,
): PrecompiledControllerDescriptor | undefined {
  return MetadataRegistry.getPrecompiledController(controller);
}

export function invalidateControllerCache(controller?: Function): void {
  MetadataRegistry.invalidateControllerCache(controller);
}

/**
 * Wraps `descriptor.value` using `factory(original)` while preserving the
 * original function's `.name`, `.length`, and all own metadata keys via
 * `MetadataRegistry.copyMetadata`.
 */
export function wrapMethodDescriptor(
  descriptor: PropertyDescriptor,
  factory: (original: Function) => Function,
): PropertyDescriptor {
  if (!descriptor || typeof descriptor.value !== "function") {
    throw new TypeError(
      "wrapMethodDescriptor() expects a method PropertyDescriptor whose value is a function.",
    );
  }

  const original = descriptor.value as Function;
  const wrapped = factory(original);

  if (typeof wrapped !== "function") {
    throw new TypeError(
      "wrapMethodDescriptor() factory must return a function.",
    );
  }

  if (wrapped !== original) {
    const nameDesc = Object.getOwnPropertyDescriptor(original, "name");
    if (nameDesc) {
      try {
        Object.defineProperty(wrapped, "name", {
          ...nameDesc,
          configurable: true,
        });
      } catch {
        // Ignore non-configurable name descriptor
      }
    }

    const lengthDesc = Object.getOwnPropertyDescriptor(original, "length");
    if (lengthDesc) {
      try {
        Object.defineProperty(wrapped, "length", {
          ...lengthDesc,
          configurable: true,
        });
      } catch {
        // Ignore non-configurable length descriptor
      }
    }

    MetadataRegistry.copyMetadata(original, wrapped);
    descriptor.value = wrapped;
  }

  return descriptor;
}
