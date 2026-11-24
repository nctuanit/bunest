import { Module } from "../common/decorators/core.decorators";
import {
  AspectPhase,
  collectPrototypeMethodNames,
  createMethodAspectDecorator,
  getMethodAspects,
  resolveAspectOrder,
  stableSortMethodAspects,
  type AspectOrderInput,
  type AspectOrderOptions,
  type AspectPhaseName,
  type AspectPhaseValue,
  type MethodAspectContext,
  type MethodAspectHandler,
  type MethodAspectMetadata,
  type MethodAspectToken,
} from "../common/decorators/method-aspect.decorator";
import type { DynamicModule } from "../common/interfaces/module.interface";
import type { Provider } from "../common/interfaces/provider.interface";
import type { InjectionToken, Type } from "../common/interfaces/type.interface";
import { MetadataRegistry } from "../common/metadata/metadata-registry";

export {
  AspectPhase,
  resolveAspectOrder,
  type AspectOrderInput,
  type AspectOrderOptions,
  type AspectPhaseName,
  type AspectPhaseValue,
};

// =============================================================================
// Composable Aspect Pipelines (`defineAspectPipeline`)
// =============================================================================

/**
 * Declarative aspect binding step inside `defineAspectPipeline(...)`.
 */
export interface AspectPipelineStepSpec<TOptions = any> {
  readonly token: MethodAspectToken<TOptions>;
  readonly options?: TOptions;
  readonly phase?: AspectPhaseValue | number;
  readonly order?: number;
}

/**
 * A single step accepted by `defineAspectPipeline(...)`: either an existing
 * class/method aspect decorator (including another pipeline) or a declarative
 * `{ token, options?, phase?, order? }` binding spec.
 */
export type AspectPipelineStep =
  | ClassDecorator
  | MethodDecorator
  | (ClassDecorator & MethodDecorator)
  | AspectPipelineStepSpec;

function isAspectPipelineStepSpec(
  step: unknown,
): step is AspectPipelineStepSpec {
  return typeof step === "object" && step !== null && "token" in step;
}

function stepToDecorator(
  step: AspectPipelineStep,
): ClassDecorator & MethodDecorator {
  if (isAspectPipelineStepSpec(step)) {
    const orderOrPhase: AspectOrderOptions | undefined =
      step.phase !== undefined || step.order !== undefined
        ? {
            ...(step.phase !== undefined ? { phase: step.phase } : {}),
            ...(step.order !== undefined ? { order: step.order } : {}),
          }
        : undefined;
    return createMethodAspectDecorator(step.token, step.options, orderOrPhase);
  }
  return step as ClassDecorator & MethodDecorator;
}

function composePipelineSteps(
  steps: readonly AspectPipelineStep[],
): ClassDecorator & MethodDecorator {
  const decorators: Array<ClassDecorator & MethodDecorator> = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step !== undefined && step !== null) {
      decorators.push(stepToDecorator(step));
    }
  }

  return (
    target: object,
    propertyKey?: string | symbol,
    descriptor?: PropertyDescriptor,
  ): any => {
    // Apply bottom-to-top (reverse order) so prepending aspect metadata
    // preserves exact top-to-bottom declaration order for same-phase steps,
    // while semantic AspectPhase / order sorting runs deterministically.
    if (propertyKey === undefined && descriptor === undefined) {
      let currentTarget: any = target;
      for (let i = decorators.length - 1; i >= 0; i--) {
        const result = (decorators[i] as ClassDecorator)(
          currentTarget as Function,
        );
        if (typeof result === "function") {
          currentTarget = result;
        }
      }
      return currentTarget;
    }

    let currentDescriptor = descriptor;
    for (let i = decorators.length - 1; i >= 0; i--) {
      const result = (decorators[i] as MethodDecorator)(
        target,
        propertyKey!,
        currentDescriptor as PropertyDescriptor,
      );
      if (result && typeof result === "object") {
        currentDescriptor = result as PropertyDescriptor;
      }
    }
    return currentDescriptor;
  };
}

/**
 * Composes multiple method/class aspect decorators or `{ token, options?, phase?, order? }`
 * specs into a single reusable `ClassDecorator & MethodDecorator`, automatically
 * preserving semantic `AspectPhase` ordering and top-to-bottom same-phase order.
 *
 * Also supports a parameterized factory form:
 * ```ts
 * const ResilientQuery = defineAspectPipeline((opts: { ttl: number }) => [
 *   WithTracing(),
 *   { token: CacheAspect, options: { ttl: opts.ttl }, phase: AspectPhase.CACHE },
 * ]);
 * ```
 */
export function defineAspectPipeline(
  steps: readonly AspectPipelineStep[],
): ClassDecorator & MethodDecorator;
export function defineAspectPipeline<TOptions = void>(
  factory: (options: TOptions) => readonly AspectPipelineStep[],
): [TOptions] extends [void]
  ? () => ClassDecorator & MethodDecorator
  : undefined extends TOptions
    ? (options?: TOptions) => ClassDecorator & MethodDecorator
    : (options: TOptions) => ClassDecorator & MethodDecorator;
export function defineAspectPipeline<TOptions = void>(
  stepsOrFactory:
    | readonly AspectPipelineStep[]
    | ((options: TOptions) => readonly AspectPipelineStep[]),
):
  | (ClassDecorator & MethodDecorator)
  | ((options?: TOptions) => ClassDecorator & MethodDecorator) {
  if (typeof stepsOrFactory === "function") {
    return (options?: TOptions): ClassDecorator & MethodDecorator =>
      composePipelineSteps(stepsOrFactory(options as TOptions));
  }
  return composePipelineSteps(stepsOrFactory);
}

// =============================================================================
// Strongly-Typed Aspects (`createTypedAspect`)
// =============================================================================

/**
 * Strongly-typed execution context passed to `createTypedAspect(...)` handlers.
 */
export interface TypedMethodAspectContext<
  TOptions = undefined,
  TArgs extends readonly unknown[] = readonly unknown[],
  TReturn = unknown,
> {
  readonly target: object;
  readonly targetClass: Type<unknown>;
  readonly methodName: string | symbol;
  readonly args: TArgs;
  readonly options: TOptions;
  proceed: (...overrideArgs: Partial<TArgs> | []) => TReturn | Promise<TReturn>;
  readonly container?: unknown;
}

type MethodArgsConstraint<TArgs extends readonly unknown[]> =
  unknown[] extends TArgs ? any[] : [...TArgs];

/**
 * Compile-time constrained method decorator matching `(TArgs) => TReturn | Promise<Awaited<TReturn>>`.
 */
export type TypedMethodDecorator<
  TArgs extends readonly unknown[] = readonly unknown[],
  TReturn = unknown,
> = <
  T extends (
    ...args: MethodArgsConstraint<TArgs>
  ) => TReturn | Promise<Awaited<TReturn>>,
>(
  target: object,
  propertyKey: string | symbol,
  descriptor: TypedPropertyDescriptor<T>,
) => TypedPropertyDescriptor<T> | void;

/**
 * Compile-time constrained method decorator requiring an async (`Promise`-returning) method.
 */
export type AsyncTypedMethodDecorator<
  TArgs extends readonly unknown[] = readonly unknown[],
  TReturn = unknown,
> = <
  T extends (...args: MethodArgsConstraint<TArgs>) => Promise<Awaited<TReturn>>,
>(
  target: object,
  propertyKey: string | symbol,
  descriptor: TypedPropertyDescriptor<T>,
) => TypedPropertyDescriptor<T> | void;

export interface TypedAspectConfigBase<
  TArgs extends readonly unknown[] = readonly unknown[],
  TReturn = unknown,
  TOptions = undefined,
> {
  /**
   * Optional DI token (or handler class/instance) to resolve when the aspect runs.
   * Either `token` or `intercept` must be supplied.
   */
  readonly token?: MethodAspectToken<TOptions>;
  /**
   * Strongly-typed inline aspect interceptor function.
   */
  readonly intercept?: (
    ctx: TypedMethodAspectContext<TOptions, TArgs, TReturn>,
  ) => TReturn | Promise<TReturn>;
  /**
   * Semantic execution phase from `AspectPhase`.
   */
  readonly phase?: AspectPhaseValue | number;
  /**
   * Numeric execution order (or sub-phase offset when combined with `phase`).
   */
  readonly order?: number;
  /**
   * Optional fallback options used when the decorator is invoked without arguments.
   */
  readonly defaultOptions?: TOptions;
}

export interface AsyncTypedAspectConfig<
  TArgs extends readonly unknown[] = readonly unknown[],
  TReturn = unknown,
  TOptions = undefined,
> extends TypedAspectConfigBase<TArgs, TReturn, TOptions> {
  /**
   * Constrains the returned method decorator at compile time to async
   * (`Promise`-returning) methods only.
   */
  readonly asyncOnly: true;
}

export interface TypedAspectConfig<
  TArgs extends readonly unknown[] = readonly unknown[],
  TReturn = unknown,
  TOptions = undefined,
> extends TypedAspectConfigBase<TArgs, TReturn, TOptions> {
  readonly asyncOnly?: false;
}

export type TypedAspectDecoratorFactory<
  TArgs extends readonly unknown[],
  TReturn,
  TOptions,
  TAsyncOnly extends boolean,
> = [TOptions] extends [undefined]
  ? (
      options?: TOptions,
    ) => TAsyncOnly extends true
      ? AsyncTypedMethodDecorator<TArgs, TReturn>
      : TypedMethodDecorator<TArgs, TReturn>
  : undefined extends TOptions
    ? (
        options?: TOptions,
      ) => TAsyncOnly extends true
        ? AsyncTypedMethodDecorator<TArgs, TReturn>
        : TypedMethodDecorator<TArgs, TReturn>
    : (
        options: TOptions,
      ) => TAsyncOnly extends true
        ? AsyncTypedMethodDecorator<TArgs, TReturn>
        : TypedMethodDecorator<TArgs, TReturn>;

/**
 * Creates a strongly-typed service-layer AOP method decorator factory with
 * typed `args`, `proceed(...)`, `options`, semantic `phase`/`order`, and an
 * optional `asyncOnly: true` compile-time constraint for `Promise`-returning methods.
 */
export function createTypedAspect<
  TArgs extends readonly unknown[] = readonly unknown[],
  TReturn = unknown,
  TOptions = undefined,
>(
  config: AsyncTypedAspectConfig<TArgs, TReturn, TOptions>,
): TypedAspectDecoratorFactory<TArgs, TReturn, TOptions, true>;
export function createTypedAspect<
  TArgs extends readonly unknown[] = readonly unknown[],
  TReturn = unknown,
  TOptions = undefined,
>(
  config: TypedAspectConfig<TArgs, TReturn, TOptions>,
): TypedAspectDecoratorFactory<TArgs, TReturn, TOptions, false>;
export function createTypedAspect<
  TArgs extends readonly unknown[] = readonly unknown[],
  TReturn = unknown,
  TOptions = undefined,
>(
  config:
    | AsyncTypedAspectConfig<TArgs, TReturn, TOptions>
    | TypedAspectConfig<TArgs, TReturn, TOptions>,
): (options?: TOptions) => MethodDecorator {
  let token: MethodAspectToken<TOptions>;

  if (config.token !== undefined) {
    token = config.token;
  } else if (typeof config.intercept === "function") {
    const interceptFn = config.intercept;
    const handler: MethodAspectHandler<TOptions> = {
      intercept(ctx: MethodAspectContext<TOptions>) {
        return interceptFn(
          ctx as unknown as TypedMethodAspectContext<TOptions, TArgs, TReturn>,
        );
      },
    };
    token = handler;
  } else {
    throw new TypeError(
      "createTypedAspect() requires either an `intercept` function or a `token`.",
    );
  }

  const orderOrPhase: AspectOrderOptions | undefined =
    config.phase !== undefined || config.order !== undefined
      ? {
          ...(config.phase !== undefined ? { phase: config.phase } : {}),
          ...(config.order !== undefined ? { order: config.order } : {}),
        }
      : undefined;

  return (options?: TOptions): MethodDecorator => {
    const resolvedOptions =
      options !== undefined ? options : config.defaultOptions;
    return createMethodAspectDecorator<TOptions>(
      token,
      resolvedOptions,
      orderOrPhase,
    );
  };
}

// =============================================================================
// Declarative Pointcuts (`PointcutRule`, `AopModule`, Global Pointcuts)
// =============================================================================

/**
 * Well-known DI injection token storing module-registered or global `PointcutRule[]`.
 */
export const AOP_POINTCUTS_TOKEN = Symbol.for("bunest:aop:pointcuts");

/**
 * Aspect entry bound by a matching `PointcutRule`.
 */
export interface PointcutAspectEntry<TOptions = any> {
  readonly token: MethodAspectToken<TOptions>;
  readonly options?: TOptions;
  readonly phase?: AspectPhaseValue | number;
  readonly order?: number;
}

/**
 * Declarative matching criteria for a `PointcutRule`.
 * All specified criteria are combined with logical AND.
 */
export interface PointcutMatcher {
  /**
   * Matches the class constructor name (exact string, `*`/`?` glob wildcard,
   * `RegExp`, or custom predicate receiving `(className, targetClass)`).
   */
  readonly className?:
    | string
    | RegExp
    | ((name: string, target: Type<unknown>) => boolean);
  /**
   * Matches the method name (exact string, `*`/`?` glob wildcard, `RegExp`,
   * or custom predicate receiving `(methodName)`).
   */
  readonly methodName?: string | RegExp | ((name: string) => boolean);
  /**
   * Method names explicitly excluded from matching.
   */
  readonly excludeMethods?: readonly string[];
  /**
   * Requires metadata defined under `metadataKey` on the method function,
   * prototype property, or class constructor.
   */
  readonly metadataKey?: string | symbol;
  /**
   * Arbitrary custom matcher predicate receiving `(targetClass, methodName)`.
   */
  readonly predicate?: (
    target: Type<unknown>,
    methodName: string | symbol,
  ) => boolean;
}

/**
 * Declarative AOP pointcut binding zero-annotation classes/methods to one or more aspects.
 */
export interface PointcutRule {
  readonly name?: string;
  readonly match: PointcutMatcher;
  readonly aspects: readonly PointcutAspectEntry[];
}

export interface AopModuleOptions {
  /**
   * Declarative pointcut rules evaluated during DI weaving.
   */
  readonly pointcuts?: readonly PointcutRule[];
  /**
   * When `true` (default for `AopModule.forRoot`), pointcuts apply globally across
   * the entire application container. When `false` (or via `AopModule.forFeature`),
   * pointcuts apply only to classes owned by modules importing this `AopModule`.
   * @default true
   */
  readonly global?: boolean;
  /**
   * Optional aspect handler providers to co-register and export from this module.
   */
  readonly providers?: Provider[];
}

interface GlobalPointcutStore {
  rules: PointcutRule[];
  version: number;
}

const GLOBAL_POINTCUTS_SYMBOL = Symbol.for("bunest:aop:global_pointcuts:v1");
const GLOB_PATTERN_CACHE = new Map<string, RegExp>();
const POINTCUT_NEVER_MATCH_METHODS = new Set<PropertyKey>([
  "constructor",
  "then",
]);

function getGlobalPointcutStore(): GlobalPointcutStore {
  const g = globalThis as Record<PropertyKey, unknown>;
  let store = g[GLOBAL_POINTCUTS_SYMBOL] as GlobalPointcutStore | undefined;
  if (!store) {
    store = { rules: [], version: 0 };
    g[GLOBAL_POINTCUTS_SYMBOL] = store;
  }
  return store;
}

/**
 * Registers one or more global declarative pointcut rules applied across all
 * `DIContainer` instances. Returns a dispose function that removes the added rules.
 */
export function registerGlobalPointcuts(
  ...rules: Array<PointcutRule | readonly PointcutRule[]>
): () => void {
  const flat: PointcutRule[] = [];
  for (let i = 0; i < rules.length; i++) {
    const item = rules[i];
    if (Array.isArray(item)) {
      for (let j = 0; j < item.length; j++) {
        flat.push(item[j] as PointcutRule);
      }
    } else if (item) {
      flat.push(item as PointcutRule);
    }
  }

  if (flat.length === 0) {
    return () => {};
  }

  const store = getGlobalPointcutStore();
  store.rules.push(...flat);
  store.version += 1;

  let disposed = false;
  return () => {
    if (disposed) {
      return;
    }
    disposed = true;
    const toRemove = new Set<PointcutRule>(flat);
    const prevLen = store.rules.length;
    store.rules = store.rules.filter((r) => !toRemove.has(r));
    if (store.rules.length !== prevLen) {
      store.version += 1;
    }
  };
}

/**
 * Removes a registered global pointcut rule by reference or by `rule.name`.
 */
export function unregisterGlobalPointcut(
  ruleOrName: PointcutRule | string,
): boolean {
  const store = getGlobalPointcutStore();
  const prevLen = store.rules.length;
  if (typeof ruleOrName === "string") {
    store.rules = store.rules.filter((r) => r.name !== ruleOrName);
  } else {
    store.rules = store.rules.filter((r) => r !== ruleOrName);
  }
  if (store.rules.length !== prevLen) {
    store.version += 1;
    return true;
  }
  return false;
}

/**
 * Returns the currently registered global `PointcutRule`s.
 */
export function getGlobalPointcuts(): readonly PointcutRule[] {
  return getGlobalPointcutStore().rules;
}

/**
 * Clears all globally registered pointcut rules (ideal for test teardown).
 */
export function clearGlobalPointcuts(): void {
  const store = getGlobalPointcutStore();
  if (store.rules.length > 0) {
    store.rules = [];
    store.version += 1;
  }
}

/**
 * Monotonic version counter incremented whenever global pointcuts change,
 * allowing `DIContainer`'s O(1) `WeakMap` presence cache to self-invalidate cleanly.
 */
export function getGlobalPointcutsVersion(): number {
  return getGlobalPointcutStore().version;
}

function getProviderExportToken(provider: Provider): InjectionToken {
  return typeof provider === "function" ? provider : provider.provide;
}

/**
 * Declarative AOP module registering `PointcutRule`s on `AOP_POINTCUTS_TOKEN`.
 *
 * - `AopModule.forRoot({ pointcuts })` registers app-wide pointcuts (`global: true` by default).
 * - `AopModule.forFeature({ pointcuts })` (or `forRoot({ pointcuts, global: false })`)
 *   registers module-scoped pointcuts visible only to importing modules.
 */
@Module({})
export class AopModule {
  static forRoot(options: AopModuleOptions = {}): DynamicModule {
    const extraProviders = options.providers ? [...options.providers] : [];
    const extraExports: InjectionToken[] = extraProviders.map(
      getProviderExportToken,
    );

    return {
      module: AopModule,
      global: options.global ?? true,
      providers: [
        {
          provide: AOP_POINTCUTS_TOKEN,
          useValue: [...(options.pointcuts ?? [])],
        },
        ...extraProviders,
      ],
      exports: [AOP_POINTCUTS_TOKEN, ...extraExports],
    };
  }

  static forFeature(
    options: Omit<AopModuleOptions, "global"> = {},
  ): DynamicModule {
    return AopModule.forRoot({
      ...options,
      global: false,
    });
  }
}

// =============================================================================
// Pointcut Matching & Effective Aspect Collection
// =============================================================================

function compileSimpleGlob(pattern: string): RegExp {
  let cached = GLOB_PATTERN_CACHE.get(pattern);
  if (!cached) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    const regexSource = `^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`;
    cached = new RegExp(regexSource);
    GLOB_PATTERN_CACHE.set(pattern, cached);
  }
  return cached;
}

function matchesNamePattern(value: string, pattern: string | RegExp): boolean {
  if (typeof pattern === "string") {
    if (pattern.includes("*") || pattern.includes("?")) {
      return compileSimpleGlob(pattern).test(value);
    }
    return value === pattern;
  }
  pattern.lastIndex = 0;
  return pattern.test(value);
}

function resolveTargetConstructor(target: object): Function | undefined {
  if (typeof target === "function") {
    return target;
  }
  const ctor = (target as { constructor?: unknown }).constructor;
  return typeof ctor === "function" ? ctor : undefined;
}

function findMethodFunction(
  targetClass: Function,
  methodName: string | symbol,
  instance?: object,
): Function | undefined {
  if (instance) {
    const ownDesc = Object.getOwnPropertyDescriptor(instance, methodName);
    if (ownDesc && typeof ownDesc.value === "function") {
      return ownDesc.value as Function;
    }
  }
  let proto: object | null = (targetClass.prototype as object | null) ?? null;
  while (proto && proto !== Object.prototype) {
    const desc = Object.getOwnPropertyDescriptor(proto, methodName);
    if (desc && typeof desc.value === "function") {
      return desc.value as Function;
    }
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  return undefined;
}

function hasMetadataKeyMatch(
  metadataKey: string | symbol,
  targetClass: Function,
  methodName: string | symbol,
  instance?: object,
): boolean {
  if (MetadataRegistry.has(metadataKey, targetClass)) {
    return true;
  }
  const methodFn = findMethodFunction(targetClass, methodName, instance);
  if (methodFn && MetadataRegistry.has(metadataKey, methodFn)) {
    return true;
  }
  const proto = targetClass.prototype as object | undefined;
  if (proto && MetadataRegistry.has(metadataKey, proto, methodName)) {
    return true;
  }
  return false;
}

function ruleHasApplicableAspects(
  rule: PointcutRule,
  targetClass: Function,
): boolean {
  for (let i = 0; i < rule.aspects.length; i++) {
    if (rule.aspects[i]!.token !== targetClass) {
      return true;
    }
  }
  return false;
}

/**
 * Checks whether a `PointcutRule`'s class-level matcher (`match.className`)
 * matches `targetClass`.
 */
export function matchesPointcutClass(
  rule: PointcutRule,
  targetClass: Function,
): boolean {
  if (targetClass === AopModule) {
    return false;
  }
  const classMatcher = rule.match.className;
  if (classMatcher === undefined) {
    return true;
  }
  const className = targetClass.name || "";
  if (typeof classMatcher === "function") {
    return Boolean(classMatcher(className, targetClass as Type<unknown>));
  }
  return matchesNamePattern(className, classMatcher);
}

/**
 * Checks whether a `PointcutRule` matches `(targetClass, methodName)`.
 */
export function matchesPointcutMethod(
  rule: PointcutRule,
  targetClass: Function,
  methodName: string | symbol,
  instance?: object,
): boolean {
  if (POINTCUT_NEVER_MATCH_METHODS.has(methodName)) {
    return false;
  }
  if (!ruleHasApplicableAspects(rule, targetClass)) {
    return false;
  }
  if (!matchesPointcutClass(rule, targetClass)) {
    return false;
  }

  const { match } = rule;

  if (
    match.excludeMethods &&
    match.excludeMethods.length > 0 &&
    typeof methodName === "string" &&
    match.excludeMethods.includes(methodName)
  ) {
    return false;
  }

  if (match.methodName !== undefined) {
    if (typeof methodName !== "string") {
      return false;
    }
    if (typeof match.methodName === "function") {
      if (!match.methodName(methodName)) {
        return false;
      }
    } else if (!matchesNamePattern(methodName, match.methodName)) {
      return false;
    }
  }

  if (
    match.metadataKey !== undefined &&
    !hasMetadataKeyMatch(match.metadataKey, targetClass, methodName, instance)
  ) {
    return false;
  }

  if (
    match.predicate !== undefined &&
    !match.predicate(targetClass as Type<unknown>, methodName)
  ) {
    return false;
  }

  return true;
}

function collectCandidateMethodNames(
  targetClass: Function,
  instance?: object,
): Array<string | symbol> {
  const names = collectPrototypeMethodNames(targetClass);
  if (!instance) {
    return names;
  }
  const seen = new Set<string | symbol>(names);
  const ownKeys: Array<string | symbol> = [
    ...Object.getOwnPropertyNames(instance),
    ...Object.getOwnPropertySymbols(instance),
  ];
  for (let i = 0; i < ownKeys.length; i++) {
    const key = ownKeys[i]!;
    if (POINTCUT_NEVER_MATCH_METHODS.has(key) || seen.has(key)) {
      continue;
    }
    const desc = Object.getOwnPropertyDescriptor(instance, key);
    if (desc && typeof desc.value === "function") {
      seen.add(key);
      names.push(key);
    }
  }
  return names;
}

/**
 * Fast check indicating whether any supplied `PointcutRule` matches at least
 * one method of `targetClass` (or potentially matches dynamic proxy methods when
 * `includeDynamicMethods: true`).
 */
export function hasMatchingPointcuts(
  targetClass: Function,
  pointcuts?: readonly PointcutRule[],
  options?: { readonly includeDynamicMethods?: boolean },
): boolean {
  if (!pointcuts || pointcuts.length === 0 || targetClass === AopModule) {
    return false;
  }

  let protoMethods: Array<string | symbol> | undefined;

  for (let i = 0; i < pointcuts.length; i++) {
    const rule = pointcuts[i]!;
    if (!ruleHasApplicableAspects(rule, targetClass)) {
      continue;
    }
    if (!matchesPointcutClass(rule, targetClass)) {
      continue;
    }

    if (protoMethods === undefined) {
      protoMethods = collectPrototypeMethodNames(targetClass);
    }

    for (let j = 0; j < protoMethods.length; j++) {
      if (matchesPointcutMethod(rule, targetClass, protoMethods[j]!)) {
        return true;
      }
    }

    if (options?.includeDynamicMethods) {
      if (
        rule.match.metadataKey !== undefined &&
        !MetadataRegistry.has(rule.match.metadataKey, targetClass)
      ) {
        continue;
      }
      return true;
    }
  }

  return false;
}

/**
 * Returns all pointcut-derived `MethodAspectMetadata` entries matching `(targetClass, methodName)`.
 */
export function getMatchingPointcutAspects(
  targetClass: Function,
  methodName: string | symbol,
  pointcuts?: readonly PointcutRule[],
  instance?: object,
): MethodAspectMetadata[] {
  if (!pointcuts || pointcuts.length === 0 || targetClass === AopModule) {
    return [];
  }

  const matched: MethodAspectMetadata[] = [];
  for (let i = 0; i < pointcuts.length; i++) {
    const rule = pointcuts[i]!;
    if (!matchesPointcutMethod(rule, targetClass, methodName, instance)) {
      continue;
    }
    for (let j = 0; j < rule.aspects.length; j++) {
      const entry = rule.aspects[j]!;
      // Prevent accidental self-weaving recursion on aspect handler classes
      if (entry.token === targetClass) {
        continue;
      }
      const resolvedOrder = resolveAspectOrder({
        ...(entry.phase !== undefined ? { phase: entry.phase } : {}),
        ...(entry.order !== undefined ? { order: entry.order } : {}),
      });
      matched.push({
        token: entry.token,
        ...(entry.options !== undefined ? { options: entry.options } : {}),
        ...(resolvedOrder !== undefined ? { order: resolvedOrder } : {}),
        methodName,
      });
    }
  }

  return matched;
}

/**
 * Returns all effective method aspects (both decorator-declared and pointcut-matched)
 * for a single `(target, methodName)`, stably sorted by `order ?? 0` / `AspectPhase`.
 */
export function getEffectiveMethodAspects(
  target: object,
  methodName: string | symbol,
  pointcuts?: readonly PointcutRule[],
  instance?: object,
): MethodAspectMetadata[] {
  const decoratorAspects = getMethodAspects(target, methodName);
  if (!pointcuts || pointcuts.length === 0) {
    return decoratorAspects;
  }

  const ctor = resolveTargetConstructor(target);
  if (!ctor) {
    return decoratorAspects;
  }

  const pointcutAspects = getMatchingPointcutAspects(
    ctor,
    methodName,
    pointcuts,
    instance,
  );
  if (pointcutAspects.length === 0) {
    return decoratorAspects;
  }

  return stableSortMethodAspects([...pointcutAspects, ...decoratorAspects]);
}

/**
 * Returns all effective method aspects (both decorator-declared and pointcut-matched)
 * across all methods of `target`, stably sorted per method by `order ?? 0` / `AspectPhase`.
 */
export function getAllEffectiveMethodAspects(
  target: object,
  pointcuts?: readonly PointcutRule[],
  instance?: object,
): MethodAspectMetadata[] {
  const decoratorAspects = getMethodAspects(target);
  if (!pointcuts || pointcuts.length === 0) {
    return decoratorAspects;
  }

  const ctor = resolveTargetConstructor(target);
  if (!ctor) {
    return decoratorAspects;
  }

  const byMethod = new Map<string | symbol, MethodAspectMetadata[]>();
  const orderedMethods: Array<string | symbol> = [];

  for (let i = 0; i < decoratorAspects.length; i++) {
    const entry = decoratorAspects[i]!;
    let list = byMethod.get(entry.methodName);
    if (!list) {
      list = [];
      byMethod.set(entry.methodName, list);
      orderedMethods.push(entry.methodName);
    }
    list.push(entry);
  }

  const candidateMethods = collectCandidateMethodNames(ctor, instance);
  for (let i = 0; i < candidateMethods.length; i++) {
    const methodName = candidateMethods[i]!;
    const pointcutAspects = getMatchingPointcutAspects(
      ctor,
      methodName,
      pointcuts,
      instance,
    );
    if (pointcutAspects.length === 0) {
      continue;
    }
    const existing = byMethod.get(methodName);
    if (!existing) {
      orderedMethods.push(methodName);
      byMethod.set(methodName, stableSortMethodAspects(pointcutAspects));
    } else {
      byMethod.set(
        methodName,
        stableSortMethodAspects([...pointcutAspects, ...existing]),
      );
    }
  }

  const result: MethodAspectMetadata[] = [];
  for (let i = 0; i < orderedMethods.length; i++) {
    const entries = byMethod.get(orderedMethods[i]!);
    if (entries) {
      result.push(...entries);
    }
  }
  return result;
}
