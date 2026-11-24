import { METADATA_KEYS } from "../constants/metadata-keys";
import type { InjectionToken, Type } from "../interfaces/type.interface";
import { MetadataRegistry } from "../metadata/metadata-registry";

/**
 * Semantic execution phases for service-layer AOP method aspects.
 * Smaller numbers execute outermost (first on entry, last on exit);
 * larger numbers execute innermost (closest to the target method).
 */
export const AspectPhase = Object.freeze({
  OBSERVABILITY: -500,
  RESILIENCE: -400,
  RATE_LIMIT: -350,
  LOCK: -300,
  TRANSACTION: -200,
  CACHE: -100,
  VALIDATION: -50,
  DEFAULT: 0,
  EVENT: 100,
  AUDIT: 200,
} as const);

export type AspectPhaseName = keyof typeof AspectPhase;
export type AspectPhaseValue = (typeof AspectPhase)[AspectPhaseName];

export interface AspectOrderOptions {
  /**
   * Explicit numeric execution order (smaller runs outer, larger runs inner).
   * When combined with `phase`, acts as a fine-grained offset within that phase (`phase + order`).
   */
  readonly order?: number;
  /**
   * Semantic execution phase from `AspectPhase` (or numeric phase value).
   */
  readonly phase?: AspectPhaseValue | number;
}

export type AspectOrderInput = number | AspectOrderOptions;

/**
 * Resolves a numeric order or `{ phase?, order? }` descriptor into a single
 * numeric order used for outer-to-inner aspect sorting.
 */
export function resolveAspectOrder(
  orderOrPhase?: AspectOrderInput,
): number | undefined {
  if (orderOrPhase === undefined) {
    return undefined;
  }
  if (typeof orderOrPhase === "number") {
    return orderOrPhase;
  }
  const { phase, order } = orderOrPhase;
  if (phase !== undefined && order !== undefined) {
    return phase + order;
  }
  if (order !== undefined) {
    return order;
  }
  if (phase !== undefined) {
    return phase;
  }
  return undefined;
}

/**
 * Execution context passed to a `MethodAspectHandler.intercept(ctx)` invocation.
 */
export interface MethodAspectContext<TOptions = unknown> {
  readonly target: object;
  readonly targetClass: Type<unknown>;
  readonly methodName: string | symbol;
  readonly args: unknown[];
  readonly options: TOptions;
  proceed: (...overrideArgs: unknown[]) => unknown | Promise<unknown>;
  readonly container?: unknown;
}

/**
 * Contract for service-layer AOP method aspect handlers resolved from DI or
 * supplied directly to `createMethodAspectDecorator(...)`.
 */
export interface MethodAspectHandler<TOptions = unknown> {
  intercept(ctx: MethodAspectContext<TOptions>): unknown | Promise<unknown>;
}

/**
 * Functional shorthand for a `MethodAspectHandler`.
 */
export type MethodAspectFn<TOptions = unknown> = (
  ctx: MethodAspectContext<TOptions>,
) => unknown | Promise<unknown>;

/**
 * Aspect target accepted by `createMethodAspectDecorator(...)`: either a DI
 * `InjectionToken` resolving to a `MethodAspectHandler`, a direct
 * `MethodAspectHandler` instance, or a direct interceptor function.
 */
export type MethodAspectToken<TOptions = unknown> =
  InjectionToken | MethodAspectHandler<TOptions> | MethodAspectFn<TOptions>;

/**
 * Stored metadata entry describing a single method aspect binding on a class.
 */
export interface MethodAspectMetadata<TOptions = unknown> {
  readonly token: MethodAspectToken<TOptions>;
  readonly options?: TOptions;
  readonly order?: number;
  readonly methodName: string | symbol;
}

interface ClassMethodAspectMetadata<TOptions = unknown> {
  readonly token: MethodAspectToken<TOptions>;
  readonly options?: TOptions;
  readonly order?: number;
}

function resolveTargetConstructor(target: object): Function | undefined {
  if (typeof target === "function") {
    return target;
  }
  const ctor = (target as { constructor?: unknown }).constructor;
  return typeof ctor === "function" ? ctor : undefined;
}

export function collectPrototypeMethodNames(
  ctor: Function,
): Array<string | symbol> {
  const names: Array<string | symbol> = [];
  const seen = new Set<string | symbol>();
  let proto: object | null = (ctor.prototype as object | null) ?? null;

  while (proto && proto !== Object.prototype) {
    const keys: Array<string | symbol> = [
      ...Object.getOwnPropertyNames(proto),
      ...Object.getOwnPropertySymbols(proto),
    ];
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      if (key === "constructor" || seen.has(key)) {
        continue;
      }
      const desc = Object.getOwnPropertyDescriptor(proto, key);
      if (desc && typeof desc.value === "function") {
        seen.add(key);
        names.push(key);
      }
    }
    proto = Object.getPrototypeOf(proto) as object | null;
  }

  return names;
}

export function stableSortMethodAspects(
  entries: MethodAspectMetadata[],
): MethodAspectMetadata[] {
  let hasExplicitOrder = false;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i]!.order !== undefined) {
      hasExplicitOrder = true;
      break;
    }
  }
  if (!hasExplicitOrder) {
    return entries;
  }
  return entries.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/**
 * Creates a composable service-layer AOP method (and optional class) decorator
 * backed by `METADATA_KEYS.METHOD_ASPECTS` and woven automatically by `@bunest/core`'s
 * `DIContainer` across `SINGLETON`, `TRANSIENT`, and `REQUEST` scopes.
 *
 * Stacked decorators on the same method preserve top-to-bottom declaration order
 * (outermost to innermost), stably sorted by `order ?? 0` / `AspectPhase`.
 * Copy-on-write: never mutates parent class metadata.
 */
export function createMethodAspectDecorator<TOptions = undefined>(
  token: MethodAspectToken<TOptions>,
  options?: TOptions,
  orderOrPhase?: AspectOrderInput,
): ClassDecorator & MethodDecorator {
  const order = resolveAspectOrder(orderOrPhase);
  return (
    target: object,
    propertyKey?: string | symbol,
    descriptor?: PropertyDescriptor,
  ): any => {
    // Class-level application
    if (propertyKey === undefined && descriptor === undefined) {
      const classEntry: ClassMethodAspectMetadata<TOptions> = {
        token,
        ...(options !== undefined ? { options } : {}),
        ...(order !== undefined ? { order } : {}),
      };
      MetadataRegistry.prependOwnArray<ClassMethodAspectMetadata<TOptions>>(
        METADATA_KEYS.CLASS_METHOD_ASPECTS,
        [classEntry],
        target,
      );
      return target;
    }

    // Method-level application
    const ctor = resolveTargetConstructor(target);
    if (!ctor || propertyKey === undefined) {
      return descriptor;
    }

    const entry: MethodAspectMetadata<TOptions> = {
      token,
      ...(options !== undefined ? { options } : {}),
      ...(order !== undefined ? { order } : {}),
      methodName: propertyKey,
    };

    // Copy-on-write own array on target.constructor.
    // Insert before the first existing entry for the same methodName to preserve
    // top-to-bottom declaration order for stacked decorators while preserving
    // method declaration order across distinct methods.
    const existing =
      MetadataRegistry.getOwn<readonly MethodAspectMetadata[]>(
        METADATA_KEYS.METHOD_ASPECTS,
        ctor,
      ) ?? [];
    const firstSameMethodIdx = existing.findIndex(
      (item) => item.methodName === propertyKey,
    );
    const next =
      firstSameMethodIdx !== -1
        ? [
            ...existing.slice(0, firstSameMethodIdx),
            entry,
            ...existing.slice(firstSameMethodIdx),
          ]
        : [...existing, entry];

    MetadataRegistry.define(METADATA_KEYS.METHOD_ASPECTS, next, ctor);
    return descriptor;
  };
}

/**
 * Fast inheritance-safe check indicating whether a class (or any of its ancestors)
 * declares any method-level or class-level method aspects.
 */
export function hasMethodAspects(target: object): boolean {
  const ctor = resolveTargetConstructor(target);
  if (!ctor) {
    return false;
  }
  const chain = MetadataRegistry.getPrototypeChain(ctor);
  for (let i = 0; i < chain.length; i++) {
    const cls = chain[i]!;
    if (
      MetadataRegistry.hasOwn(METADATA_KEYS.METHOD_ASPECTS, cls) ||
      MetadataRegistry.hasOwn(METADATA_KEYS.CLASS_METHOD_ASPECTS, cls)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Reads effective method aspects for a class or instance across its entire
 * inheritance chain (base -> derived, class-level before method-level, top-to-bottom,
 * stably sorted by `order ?? 0`).
 *
 * When `methodName` is provided, returns only aspects targeting that method.
 */
export function getMethodAspects(
  target: object,
  methodName?: string | symbol,
): MethodAspectMetadata[] {
  const ctor = resolveTargetConstructor(target);
  if (!ctor) {
    return [];
  }

  const chain = MetadataRegistry.getPrototypeChain(ctor);
  const classAspects: ClassMethodAspectMetadata[] = [];
  const orderedMethods: Array<string | symbol> = [];
  const methodAspectsByKey = new Map<string | symbol, MethodAspectMetadata[]>();

  for (let i = 0; i < chain.length; i++) {
    const cls = chain[i]!;

    const ownClassAspects = MetadataRegistry.getOwn<
      readonly ClassMethodAspectMetadata[]
    >(METADATA_KEYS.CLASS_METHOD_ASPECTS, cls);
    if (ownClassAspects && ownClassAspects.length > 0) {
      for (let j = 0; j < ownClassAspects.length; j++) {
        classAspects.push({ ...ownClassAspects[j]! });
      }
    }

    const ownMethodAspects = MetadataRegistry.getOwn<
      readonly MethodAspectMetadata[]
    >(METADATA_KEYS.METHOD_ASPECTS, cls);
    if (ownMethodAspects && ownMethodAspects.length > 0) {
      for (let j = 0; j < ownMethodAspects.length; j++) {
        const entry = ownMethodAspects[j]!;
        let bucket = methodAspectsByKey.get(entry.methodName);
        if (!bucket) {
          bucket = [];
          methodAspectsByKey.set(entry.methodName, bucket);
          orderedMethods.push(entry.methodName);
        }
        bucket.push({ ...entry });
      }
    }
  }

  if (methodName !== undefined) {
    const combined: MethodAspectMetadata[] = [];
    for (let i = 0; i < classAspects.length; i++) {
      const ca = classAspects[i]!;
      combined.push({
        token: ca.token,
        ...(ca.options !== undefined ? { options: ca.options } : {}),
        ...(ca.order !== undefined ? { order: ca.order } : {}),
        methodName,
      });
    }
    const methodEntries = methodAspectsByKey.get(methodName);
    if (methodEntries) {
      combined.push(...methodEntries);
    }
    return stableSortMethodAspects(combined);
  }

  // If class-level aspects exist, expand them onto every prototype method
  if (classAspects.length > 0) {
    const protoMethods = collectPrototypeMethodNames(ctor);
    for (let i = 0; i < protoMethods.length; i++) {
      const name = protoMethods[i]!;
      if (!methodAspectsByKey.has(name)) {
        orderedMethods.push(name);
      }
    }
  }

  const result: MethodAspectMetadata[] = [];
  for (let i = 0; i < orderedMethods.length; i++) {
    const name = orderedMethods[i]!;
    const perMethod: MethodAspectMetadata[] = [];
    for (let j = 0; j < classAspects.length; j++) {
      const ca = classAspects[j]!;
      perMethod.push({
        token: ca.token,
        ...(ca.options !== undefined ? { options: ca.options } : {}),
        ...(ca.order !== undefined ? { order: ca.order } : {}),
        methodName: name,
      });
    }
    const methodEntries = methodAspectsByKey.get(name);
    if (methodEntries) {
      perMethod.push(...methodEntries);
    }
    result.push(...stableSortMethodAspects(perMethod));
  }

  return result;
}
