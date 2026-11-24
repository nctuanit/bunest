import {
  METADATA_KEYS,
  MetadataRegistry,
  hasMethodAspects,
  wrapMethodDescriptor,
  type Abstract,
  type InjectionToken,
  type MethodAspectContext,
  type MethodAspectFn,
  type MethodAspectHandler,
  type MethodAspectMetadata,
  type MethodAspectToken,
  type Type,
} from "../common/index";
import type { RequestContainer } from "../di/request-container";
import { formatToken } from "../errors/token-formatter";
import type { ModuleNode } from "../module/module-node";
import {
  getAllEffectiveMethodAspects,
  getEffectiveMethodAspects,
  hasMatchingPointcuts,
  matchesPointcutClass,
  type PointcutRule,
} from "./aop-pipeline";

export interface ResolvedAspectEntry {
  readonly found: boolean;
  readonly handler?: unknown;
  readonly deferred?: boolean;
  readonly cacheable?: boolean;
  readonly error?: unknown;
}

export type AspectResolutionValue =
  MethodAspectHandler | MethodAspectFn | ResolvedAspectEntry | undefined;

/**
 * Functional resolver for looking up a `MethodAspectHandler` / `MethodAspectFn`
 * (or structured `ResolvedAspectEntry`) from a DI token during proxy/executor weaving.
 */
export type AspectResolverFn = (
  token: InjectionToken,
  isLazyCall?: boolean,
) => AspectResolutionValue | Promise<AspectResolutionValue>;

/**
 * Structured aspect resolver object supporting optional `container` propagation
 * onto `MethodAspectContext.container`.
 */
export interface AspectResolverObject {
  resolve: AspectResolverFn;
  readonly container?: unknown;
}

/**
 * Flexible aspect resolver accepted by `weaveMethodExecutor()` and
 * `weaveProxyMethodAspects()`.
 */
export type AspectResolver = AspectResolverFn | AspectResolverObject;

/**
 * Structural host interface implemented by `DIContainer` so the weaver remains
 * completely decoupled with zero circular imports.
 */
export interface MethodAspectResolverHost {
  resolveAspectToken(
    token: InjectionToken,
    owner: ModuleNode,
    requestContainer: RequestContainer | undefined,
    activeInstantiations: Set<string>,
    isLazyCall?: boolean,
  ): Promise<ResolvedAspectEntry>;
}

const WOVEN_PROXIES = new WeakSet<object>();

const PROXY_PASSTHROUGH_KEYS = new Set<PropertyKey>([
  "constructor",
  "then",
  "catch",
  "finally",
  "toJSON",
  "valueOf",
  "toString",
  "inspect",
  Symbol.toPrimitive,
  Symbol.toStringTag,
  Symbol.iterator,
  Symbol.asyncIterator,
  Symbol.hasInstance,
  Symbol.isConcatSpreadable,
]);

const NEVER_WRAP_KEYS = new Set<PropertyKey>(["constructor", "then"]);

export function isMethodAspectHandlerObject(
  value: unknown,
): value is MethodAspectHandler {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<MethodAspectHandler>).intercept === "function"
  );
}

export function isMethodAspectClass(
  value: unknown,
): value is Type<MethodAspectHandler> {
  return (
    typeof value === "function" &&
    (typeof (value as { prototype?: { intercept?: unknown } }).prototype
      ?.intercept === "function" ||
      MetadataRegistry.has(METADATA_KEYS.INJECTABLE, value))
  );
}

function isPromiseLike<T = unknown>(value: unknown): value is PromiseLike<T> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as PromiseLike<T>).then === "function"
  );
}

function isResolvedAspectEntry(value: unknown): value is ResolvedAspectEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    "found" in value &&
    typeof (value as ResolvedAspectEntry).found === "boolean" &&
    !isMethodAspectHandlerObject(value)
  );
}

function toCallableHandler(
  resolved: unknown,
  token: MethodAspectToken,
  className: string,
  methodName: string | symbol,
): MethodAspectHandler {
  if (isMethodAspectHandlerObject(resolved)) {
    return resolved;
  }
  if (typeof resolved === "function") {
    return { intercept: resolved as MethodAspectFn };
  }
  throw new Error(
    `Method aspect handler for token ${formatToken(token)} on ${className}.${String(methodName)} must implement MethodAspectHandler.intercept(ctx) or be a callable function.`,
  );
}

function invokeAspectResolver(
  resolver: AspectResolver,
  token: InjectionToken,
  isLazyCall: boolean,
): AspectResolutionValue | Promise<AspectResolutionValue> {
  if (typeof resolver === "function") {
    return resolver(token, isLazyCall);
  }
  return resolver.resolve(token, isLazyCall);
}

function getResolverContainer(resolver: AspectResolver): unknown {
  return typeof resolver === "object" && resolver !== null
    ? resolver.container
    : undefined;
}

function hasExplicitMethodAspectForKey(
  targetClass: Function,
  methodName: string | symbol,
): boolean {
  const chain = MetadataRegistry.getPrototypeChain(targetClass);
  for (let i = 0; i < chain.length; i++) {
    const own = MetadataRegistry.getOwn<readonly MethodAspectMetadata[]>(
      METADATA_KEYS.METHOD_ASPECTS,
      chain[i]!,
    );
    if (!own) {
      continue;
    }
    for (let j = 0; j < own.length; j++) {
      if (own[j]!.methodName === methodName) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Collects all unique DI aspect tokens declared at class-level, method-level,
 * or via matching declarative `PointcutRule`s across `targetClass`'s inheritance
 * chain (used to eagerly pre-warm singleton aspect handlers for `useFactory`
 * and `Proxy`-backed providers).
 */
export function collectClassAspectTokens(
  targetClass: Abstract<unknown> | Type<unknown>,
  pointcuts?: readonly PointcutRule[],
): InjectionToken[] {
  const tokens = new Set<InjectionToken>();
  const chain = MetadataRegistry.getPrototypeChain(targetClass);

  for (let i = 0; i < chain.length; i++) {
    const cls = chain[i]!;
    const classAspects = MetadataRegistry.getOwn<
      readonly { readonly token: MethodAspectToken }[]
    >(METADATA_KEYS.CLASS_METHOD_ASPECTS, cls);
    if (classAspects) {
      for (let j = 0; j < classAspects.length; j++) {
        const tok = classAspects[j]!.token;
        if (!isMethodAspectHandlerObject(tok)) {
          tokens.add(tok as InjectionToken);
        }
      }
    }

    const methodAspects = MetadataRegistry.getOwn<
      readonly MethodAspectMetadata[]
    >(METADATA_KEYS.METHOD_ASPECTS, cls);
    if (methodAspects) {
      for (let j = 0; j < methodAspects.length; j++) {
        const tok = methodAspects[j]!.token;
        if (!isMethodAspectHandlerObject(tok)) {
          tokens.add(tok as InjectionToken);
        }
      }
    }
  }

  if (pointcuts && pointcuts.length > 0) {
    for (let i = 0; i < pointcuts.length; i++) {
      const rule = pointcuts[i]!;
      if (!matchesPointcutClass(rule, targetClass)) {
        continue;
      }
      for (let j = 0; j < rule.aspects.length; j++) {
        const tok = rule.aspects[j]!.token;
        if (tok !== targetClass && !isMethodAspectHandlerObject(tok)) {
          tokens.add(tok as InjectionToken);
        }
      }
    }
  }

  return [...tokens];
}

interface CompiledAspectSlot {
  readonly meta: MethodAspectMetadata;
  handler?: MethodAspectHandler;
  readonly resolveLazy?: () => Promise<MethodAspectHandler>;
}

interface DynamicAspectSlot {
  readonly meta: MethodAspectMetadata;
  handler?: MethodAspectHandler;
}

function finalizeDynamicSlot(
  slot: DynamicAspectSlot,
  raw: AspectResolutionValue,
  className: string,
  methodName: string | symbol,
): MethodAspectHandler {
  const token = slot.meta.token;

  if (isResolvedAspectEntry(raw)) {
    if (!raw.found) {
      if (typeof token === "function" && !isMethodAspectClass(token)) {
        const direct: MethodAspectHandler = {
          intercept: token as MethodAspectFn,
        };
        slot.handler = direct;
        return direct;
      }
      if (raw.error instanceof Error) {
        throw raw.error;
      }
      throw new Error(
        `Method aspect handler for token ${formatToken(token)} on ${className}.${String(methodName)} is not registered in the DI container.`,
      );
    }
    const callable = toCallableHandler(
      raw.handler,
      token,
      className,
      methodName,
    );
    if (raw.cacheable !== false) {
      slot.handler = callable;
    }
    return callable;
  }

  if (raw !== undefined && raw !== null) {
    const callable = toCallableHandler(raw, token, className, methodName);
    slot.handler = callable;
    return callable;
  }

  if (typeof token === "function" && !isMethodAspectClass(token)) {
    const direct: MethodAspectHandler = {
      intercept: token as MethodAspectFn,
    };
    slot.handler = direct;
    return direct;
  }

  throw new Error(
    `Method aspect handler for token ${formatToken(token)} on ${className}.${String(methodName)} is not registered in the DI container.`,
  );
}

/**
 * Weaves all class-level and method-level `MethodAspect` decorators matching
 * `(targetClass, methodName)` around an arbitrary `executor` function using the
 * supplied `AspectResolver`.
 *
 * Works uniformly for concrete methods, `useFactory`-created closures, CRUD
 * executors, `@Query` executors, and dynamically synthesized derived methods on
 * `Proxy`-backed repositories.
 *
 * - Returns `executor` unchanged when no aspects apply to `methodName`.
 * - Preserves synchronous execution when aspects and `resolver` are synchronous.
 * - Preserves `.name`, `.length`, and own metadata from `executor`.
 */
export function weaveMethodExecutor<
  TArgs extends unknown[] = unknown[],
  TResult = unknown,
>(
  target: object,
  targetClass: Abstract<unknown> | Type<unknown>,
  methodName: string | symbol,
  executor: (...args: TArgs) => TResult,
  resolver: AspectResolver,
  pointcuts?: readonly PointcutRule[],
): (...args: TArgs) => TResult {
  const aspects = getEffectiveMethodAspects(
    targetClass,
    methodName,
    pointcuts,
    target,
  );
  if (aspects.length === 0) {
    return executor;
  }

  const className = targetClass.name || "<AnonymousClass>";
  const resolverContainer = getResolverContainer(resolver);

  const slots: DynamicAspectSlot[] = [];
  for (let i = 0; i < aspects.length; i++) {
    const meta = aspects[i]!;
    if (isMethodAspectHandlerObject(meta.token)) {
      slots.push({ meta, handler: meta.token });
    } else {
      slots.push({ meta });
    }
  }

  const wrapped = function (this: unknown, ...callArgs: TArgs): TResult {
    const receiver = (this ?? target) as object;

    const dispatch = (index: number, args: unknown[]): unknown => {
      if (index >= slots.length) {
        return executor.apply(receiver, args as TArgs);
      }

      const slot = slots[index]!;
      const proceed = (...overrideArgs: unknown[]): unknown => {
        const nextArgs = overrideArgs.length > 0 ? overrideArgs : args;
        return dispatch(index + 1, nextArgs);
      };

      const ctx: MethodAspectContext = {
        target: receiver,
        targetClass: targetClass as Type<unknown>,
        methodName,
        args,
        options: slot.meta.options,
        proceed,
        ...(resolverContainer !== undefined
          ? { container: resolverContainer }
          : {}),
      };

      if (slot.handler) {
        return slot.handler.intercept(ctx);
      }

      const resolved = invokeAspectResolver(
        resolver,
        slot.meta.token as InjectionToken,
        true,
      );
      if (isPromiseLike(resolved)) {
        return resolved.then((res) => {
          const handler = finalizeDynamicSlot(slot, res, className, methodName);
          return handler.intercept(ctx);
        });
      }

      const handler = finalizeDynamicSlot(
        slot,
        resolved,
        className,
        methodName,
      );
      return handler.intercept(ctx);
    };

    return dispatch(0, callArgs) as TResult;
  };

  const nameDesc = Object.getOwnPropertyDescriptor(executor, "name");
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

  const lengthDesc = Object.getOwnPropertyDescriptor(executor, "length");
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

  MetadataRegistry.copyMetadata(executor, wrapped);
  return wrapped;
}

/**
 * Wraps a `useFactory`-created instance or `Proxy`-backed declarative repository
 * (e.g. `SqliteCrudRepository` / `SqlCrudRepository`) in an aspect-weaving `Proxy` so
 * BOTH class-level and method-level `MethodAspect` decorators execute seamlessly
 * on CRUD methods, `@Query` methods, concrete helpers, AND dynamically synthesized
 * derived methods.
 *
 * - Returns `proxy` untouched with zero overhead if `targetClass` has no method aspects
 *   or if `proxy` has already been woven.
 * - Caches woven method wrappers per property key for O(1) steady-state calls.
 */
export function weaveProxyMethodAspects<T extends object>(
  proxy: T,
  targetClass: Abstract<T> | Type<T>,
  resolver: AspectResolver,
  pointcuts?: readonly PointcutRule[],
): T {
  if (
    proxy === null ||
    typeof proxy !== "object" ||
    WOVEN_PROXIES.has(proxy) ||
    (!hasMethodAspects(targetClass) &&
      !hasMatchingPointcuts(targetClass, pointcuts, {
        includeDynamicMethods: true,
      }))
  ) {
    return proxy;
  }

  const wrappedCache = new Map<
    string | symbol,
    { readonly original: Function; readonly wrapped: Function }
  >();

  const wovenProxy: T = new Proxy(proxy, {
    get(target, prop, _receiver) {
      if (NEVER_WRAP_KEYS.has(prop)) {
        return Reflect.get(target, prop, target);
      }

      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") {
        return value;
      }

      if (
        (typeof prop === "symbol" || PROXY_PASSTHROUGH_KEYS.has(prop)) &&
        !hasExplicitMethodAspectForKey(targetClass, prop)
      ) {
        return value;
      }

      const cached = wrappedCache.get(prop);
      if (cached && cached.original === value) {
        return cached.wrapped;
      }

      const woven = weaveMethodExecutor(
        wovenProxy,
        targetClass,
        prop,
        value as (...args: unknown[]) => unknown,
        resolver,
        pointcuts,
      );

      if (woven === value) {
        return value;
      }

      wrappedCache.set(prop, { original: value, wrapped: woven });
      return woven;
    },
  });

  WOVEN_PROXIES.add(wovenProxy);
  return wovenProxy;
}

/**
 * Weaves all declared `@MethodAspect` / `createMethodAspectDecorator()` entries
 * and matching declarative `PointcutRule`s onto the decorated/matched methods of
 * a freshly instantiated provider or controller instance, preserving `.name`,
 * `.length`, `this` binding, and all own metadata via `wrapMethodDescriptor`.
 *
 * - Synchronous aspects wrapping synchronous methods stay 100% synchronous (no Promise overhead).
 * - Multiple aspects execute outer-to-inner in exact top-to-bottom declaration order (and `order` ascending).
 * - Supports DI-injected `MethodAspectHandler` classes/tokens, direct handler instances, and direct functions.
 */
export async function weaveInstanceMethodAspects(
  instance: object,
  targetClass: Type<unknown>,
  owner: ModuleNode,
  host: MethodAspectResolverHost,
  requestContainer: RequestContainer | undefined,
  activeInstantiations: Set<string>,
  pointcuts?: readonly PointcutRule[],
): Promise<void> {
  const aspects = getAllEffectiveMethodAspects(
    targetClass,
    pointcuts,
    instance,
  );
  if (aspects.length === 0) {
    return;
  }

  const byMethod = new Map<string | symbol, MethodAspectMetadata[]>();
  for (let i = 0; i < aspects.length; i++) {
    const entry = aspects[i]!;
    let list = byMethod.get(entry.methodName);
    if (!list) {
      list = [];
      byMethod.set(entry.methodName, list);
    }
    list.push(entry);
  }

  const className = targetClass.name || "<AnonymousClass>";
  const record = instance as Record<string | symbol, unknown>;

  for (const [methodName, methodAspects] of byMethod.entries()) {
    const originalCandidate = record[methodName];
    if (typeof originalCandidate !== "function") {
      continue;
    }

    const slots: CompiledAspectSlot[] = [];

    for (let i = 0; i < methodAspects.length; i++) {
      const meta = methodAspects[i]!;
      const token = meta.token;

      // 1. Direct MethodAspectHandler object instance
      if (isMethodAspectHandlerObject(token)) {
        slots.push({ meta, handler: token });
        continue;
      }

      // 2. DI token (class, string, symbol) or direct function
      const resolution = await host.resolveAspectToken(
        token as InjectionToken,
        owner,
        requestContainer,
        activeInstantiations,
        false,
      );

      if (resolution.found && !resolution.deferred) {
        const callable = toCallableHandler(
          resolution.handler,
          token,
          className,
          methodName,
        );
        slots.push({ meta, handler: callable });
        continue;
      }

      // 3. Deferred / lazy resolution (circular self-ref, request-scoped handler on singleton, or not yet registered)
      const slot: CompiledAspectSlot = {
        meta,
        resolveLazy: async () => {
          const lazyRes = await host.resolveAspectToken(
            token as InjectionToken,
            owner,
            requestContainer,
            new Set(),
            true,
          );
          if (!lazyRes.found) {
            if (lazyRes.error instanceof Error) {
              throw lazyRes.error;
            }
            throw new Error(
              `Method aspect handler for token ${formatToken(token)} on ${className}.${String(methodName)} is not registered in the DI container.`,
            );
          }
          const callable = toCallableHandler(
            lazyRes.handler,
            token,
            className,
            methodName,
          );
          if (lazyRes.cacheable !== false) {
            slot.handler = callable;
          }
          return callable;
        },
      };
      slots.push(slot);
    }

    const existingDesc = Object.getOwnPropertyDescriptor(
      instance,
      methodName,
    ) ?? {
      value: originalCandidate,
      writable: true,
      enumerable: false,
      configurable: true,
    };

    const wrappedDesc = wrapMethodDescriptor(
      { ...existingDesc, value: originalCandidate },
      (original) =>
        function (this: unknown, ...callArgs: unknown[]): unknown {
          const receiver = (this ?? instance) as object;

          const dispatch = (index: number, args: unknown[]): unknown => {
            if (index >= slots.length) {
              return original.apply(receiver, args);
            }

            const slot = slots[index]!;
            const proceed = (...overrideArgs: unknown[]): unknown => {
              const nextArgs = overrideArgs.length > 0 ? overrideArgs : args;
              return dispatch(index + 1, nextArgs);
            };

            const ctx: MethodAspectContext = {
              target: receiver,
              targetClass,
              methodName,
              args,
              options: slot.meta.options,
              proceed,
              container: host,
            };

            if (slot.handler) {
              return slot.handler.intercept(ctx);
            }

            return slot.resolveLazy!().then((h) => h.intercept(ctx));
          };

          return dispatch(0, callArgs);
        },
    );

    Object.defineProperty(instance, methodName, wrappedDesc);
  }
}
