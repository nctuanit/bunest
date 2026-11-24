import { METADATA_KEYS } from "../../constants/metadata-keys";
import { Logger } from "../../logger/logger";
import { MetadataRegistry } from "../../metadata/metadata-registry";
import { getClassMacroConfig, invalidateMacroPlanCache } from "./macro-plan";
import {
  MEMOIZE_CACHE_SYM,
  defineIfAbsent,
  mergeDefinedOptions,
  readGlobalMacroDefaults,
  tagMacroDecorator,
  type DelegateOptions,
  type LogExecutionOptions,
  type MemoizeDecoratorOptions,
  type StandardExceptionOptions,
  type WithLoggerOptions,
} from "./macro-types";

const LOGGER_CACHE_SYM = Symbol("bunest:macro:logger");

/**
 * Lazily attaches a non-enumerable `readonly logger: Logger` (bound to `context ?? ClassName`)
 * directly on class instances — Bunest's idiomatic equivalent of `@Slf4j`.
 */
export function WithLogger(
  contextOrOptions?: string | WithLoggerOptions,
): ClassDecorator {
  const rawOptions: WithLoggerOptions =
    typeof contextOrOptions === "string"
      ? { context: contextOrOptions }
      : (contextOrOptions ?? {});

  return tagMacroDecorator((target: Function): void => {
    const effective = mergeDefinedOptions(
      readGlobalMacroDefaults().withLogger,
      rawOptions,
    );
    const propName = effective.propertyName ?? "logger";
    const cfg = getClassMacroConfig(target);
    cfg.withLogger = effective;
    invalidateMacroPlanCache(target);

    defineIfAbsent(target.prototype, propName, {
      enumerable: false,
      configurable: true,
      get(this: Record<symbol, Logger | undefined>): Logger {
        let logger = this[LOGGER_CACHE_SYM];
        if (!logger) {
          logger = new Logger(effective.context ?? target.name);
          Object.defineProperty(this, LOGGER_CACHE_SYM, {
            value: logger,
            enumerable: false,
            configurable: true,
            writable: false,
          });
        }
        return logger;
      },
    });
  }, "WithLogger");
}

interface MemoizeCacheEntry {
  readonly value: unknown;
  readonly expiresAt?: number;
}

/**
 * Clears cached `@Memoize()` entries on an instance (optionally scoped to a single method/getter name).
 */
export function clearMemoizeCache(
  instance: object,
  memberName?: string | symbol,
): void {
  const caches = (
    instance as Record<
      symbol,
      Map<PropertyKey, Map<unknown, MemoizeCacheEntry>> | undefined
    >
  )[MEMOIZE_CACHE_SYM];
  if (!caches) return;
  if (memberName !== undefined) {
    caches.delete(memberName);
  } else {
    caches.clear();
  }
}

/**
 * Memoizes a getter or method per instance (supports both sync values and Promises; auto-evicts rejected Promises).
 */
export function Memoize(options: MemoizeDecoratorOptions = {}): MethodDecorator {
  const maxSize = options.maxSize ?? 256;

  return (
    _target: object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ): PropertyDescriptor => {
    const getStore = (instance: object): Map<unknown, MemoizeCacheEntry> => {
      const host = instance as Record<
        symbol,
        Map<PropertyKey, Map<unknown, MemoizeCacheEntry>> | undefined
      >;
      let all = host[MEMOIZE_CACHE_SYM];
      if (!all) {
        all = new Map();
        Object.defineProperty(instance, MEMOIZE_CACHE_SYM, {
          value: all,
          enumerable: false,
          configurable: true,
          writable: true,
        });
      }
      let store = all.get(propertyKey);
      if (!store) {
        store = new Map();
        all.set(propertyKey, store);
      }
      return store;
    };

    const readCached = (
      store: Map<unknown, MemoizeCacheEntry>,
      key: unknown,
    ): { hit: true; value: unknown } | { hit: false } => {
      const entry = store.get(key);
      if (!entry) return { hit: false };
      if (entry.expiresAt !== undefined && Date.now() > entry.expiresAt) {
        store.delete(key);
        return { hit: false };
      }
      return { hit: true, value: entry.value };
    };

    const writeCached = (
      store: Map<unknown, MemoizeCacheEntry>,
      key: unknown,
      value: unknown,
    ): void => {
      if (store.size >= maxSize && !store.has(key)) {
        const oldestKey = store.keys().next().value;
        store.delete(oldestKey);
      }
      const expiresAt =
        options.ttlMs !== undefined ? Date.now() + options.ttlMs : undefined;
      store.set(key, { value, expiresAt });

      if (value && typeof (value as PromiseLike<unknown>).then === "function") {
        Promise.resolve(value).catch(() => {
          const current = store.get(key);
          if (current && current.value === value) {
            store.delete(key);
          }
        });
      }
    };

    if (typeof descriptor.get === "function") {
      const origGet = descriptor.get;
      descriptor.get = function (this: object) {
        const store = getStore(this);
        const cached = readCached(store, "__getter__");
        if (cached.hit) return cached.value;
        const val = origGet.call(this);
        writeCached(store, "__getter__", val);
        return val;
      };
      return descriptor;
    }

    if (typeof descriptor.value === "function") {
      const origFn = descriptor.value as (...args: unknown[]) => unknown;
      descriptor.value = function (this: object, ...args: unknown[]) {
        const store = getStore(this);
        const key = options.keyFn
          ? options.keyFn(...args)
          : args.length === 0
            ? "__no_args__"
            : args.length === 1 &&
                (typeof args[0] !== "object" || args[0] === null)
              ? args[0]
              : JSON.stringify(args);
        const cached = readCached(store, key);
        if (cached.hit) return cached.value;
        const val = origFn.apply(this, args);
        writeCached(store, key, val);
        return val;
      };
    }

    return descriptor;
  };
}

/**
 * Composition-over-inheritance decorator: forwards prototype methods of the decorated property
 * onto the host class (respecting `@Tolerate` — never overwrites own methods).
 */
export function Delegate(options: DelegateOptions = {}): PropertyDecorator {
  return (target: object, propertyKey: string | symbol): void => {
    const ctor = target.constructor;
    const excludeSet = new Set(["constructor", ...(options.excludes ?? [])]);

    const delegates =
      MetadataRegistry.getOwn<
        Array<{ readonly propertyKey: string; readonly excludes: readonly string[] }>
      >(METADATA_KEYS.MACRO_DELEGATES, ctor) ?? [];
    delegates.push({
      propertyKey: String(propertyKey),
      excludes: [...excludeSet],
    });
    MetadataRegistry.define(METADATA_KEYS.MACRO_DELEGATES, delegates, ctor);

    const methodNames = new Set<string>(options.methods ?? []);
    const designType =
      options.target ??
      (MetadataRegistry.getType(target, propertyKey) as Function | undefined);

    if (designType && typeof designType === "function" && designType.prototype) {
      let proto: object | null = designType.prototype as object;
      while (proto && proto !== Object.prototype) {
        for (const key of Object.getOwnPropertyNames(proto)) {
          if (excludeSet.has(key)) continue;
          const desc = Object.getOwnPropertyDescriptor(proto, key);
          if (desc && typeof desc.value === "function") {
            methodNames.add(key);
          }
        }
        proto = Object.getPrototypeOf(proto) as object | null;
      }
    }

    for (const methodName of methodNames) {
      if (excludeSet.has(methodName)) continue;
      defineIfAbsent(target, methodName, {
        enumerable: false,
        configurable: true,
        writable: true,
        value: function (
          this: Record<PropertyKey, unknown>,
          ...args: unknown[]
        ) {
          const delegateObj = this[propertyKey] as
            | Record<string, (...a: unknown[]) => unknown>
            | null
            | undefined;
          if (!delegateObj) {
            throw new TypeError(
              `@Delegate() property "${ctor.name}.${String(propertyKey)}" is null or undefined when calling "${methodName}()".`,
            );
          }
          const fn = delegateObj[methodName];
          if (typeof fn !== "function") {
            throw new TypeError(
              `@Delegate() target "${ctor.name}.${String(propertyKey)}" does not implement method "${methodName}()".`,
            );
          }
          return fn.apply(delegateObj, args);
        },
      });
    }
  };
}

/**
 * Standardizes custom `Error` subclasses: fixes prototype chain (`instanceof`), sets `.name`,
 * optional `.code`/`.statusCode`, accepts `(message, causeOrOptions)`, and adds static `.from(message, cause)`.
 */
export function StandardException(
  options: StandardExceptionOptions = {},
): ClassDecorator {
  return tagMacroDecorator(
    <TFunction extends Function>(target: TFunction): TFunction => {
      const cfg = getClassMacroConfig(target);
      cfg.standardException = options;
      invalidateMacroPlanCache(target);

      const Base = target as unknown as new (...args: unknown[]) => Error & {
        code?: string;
        statusCode?: number;
        cause?: unknown;
      };

      const Wrapped = class extends Base {
        constructor(...args: unknown[]) {
          let message: string | undefined;
          let cause: unknown;
          let code = options.code;
          let statusCode = options.statusCode;

          if (args.length === 1 && args[0] instanceof Error) {
            message = args[0].message;
            cause = args[0];
          } else {
            message = typeof args[0] === "string" ? args[0] : undefined;
            const second = args[1];
            if (second instanceof Error) {
              cause = second;
            } else if (second && typeof second === "object") {
              const opts = second as {
                cause?: unknown;
                code?: string;
                statusCode?: number;
              };
              cause = opts.cause;
              if (opts.code !== undefined) code = opts.code;
              if (opts.statusCode !== undefined) statusCode = opts.statusCode;
            }
          }

          super(message, cause !== undefined ? { cause } : undefined);
          Object.setPrototypeOf(this, new.target.prototype);
          this.name = new.target.name || target.name;
          if (cause !== undefined && this.cause === undefined) {
            this.cause = cause;
          }
          if (code !== undefined) {
            this.code = code;
          }
          if (statusCode !== undefined) {
            this.statusCode = statusCode;
          }
        }

        static from(message: string, cause?: unknown): Error {
          return new Wrapped(
            message,
            cause !== undefined ? { cause } : undefined,
          );
        }
      };

      Object.defineProperty(Wrapped, "name", {
        value: target.name,
        configurable: true,
      });

      return Wrapped as unknown as TFunction;
    },
    "StandardException",
  );
}

/**
 * Marks a helper class as static-only: prevents instantiation (`new Helper()` throws `TypeError`).
 */
export function UtilityClass(): ClassDecorator {
  return tagMacroDecorator(
    <TFunction extends Function>(target: TFunction): TFunction => {
      const cfg = getClassMacroConfig(target);
      cfg.utilityClass = true;
      invalidateMacroPlanCache(target);

      const Guarded = new Proxy(target, {
        construct() {
          throw new TypeError(
            `Utility class "${target.name}" cannot be instantiated.`,
          );
        },
      });
      return Guarded;
    },
    "UtilityClass",
  );
}

/**
 * Logs method execution time, slow-call warnings, and errors via Bunest `Logger`
 * (reusing `this.logger` when `@WithLogger()` is present). Preserves synchronous return values.
 */
export function LogExecution(
  options: LogExecutionOptions = {},
): ClassDecorator & MethodDecorator {
  const level = options.level ?? "debug";

  const wrapMethod = (
    ctorName: string,
    methodName: string | symbol,
    orig: (...args: unknown[]) => unknown,
  ): ((...args: unknown[]) => unknown) => {
    let fallbackLogger: Logger | undefined;
    const getLogger = (instance: object): Logger => {
      const maybe = (instance as { logger?: unknown }).logger;
      if (
        maybe &&
        typeof maybe === "object" &&
        typeof (maybe as Logger).log === "function"
      ) {
        return maybe as Logger;
      }
      if (!fallbackLogger) {
        fallbackLogger = new Logger(options.context ?? ctorName);
      }
      return fallbackLogger;
    };

    const emitSuccess = (
      logger: Logger,
      elapsedMs: number,
      args: unknown[],
      result: unknown,
    ): void => {
      const label = `${ctorName}.${String(methodName)}`;
      const extras: string[] = [];
      if (options.logArgs) extras.push(`args=${JSON.stringify(args)}`);
      if (options.logResult) extras.push(`result=${JSON.stringify(result)}`);
      const suffix = extras.length > 0 ? ` (${extras.join(", ")})` : "";
      const msg = `${label} completed in ${elapsedMs.toFixed(1)}ms${suffix}`;
      if (options.slowMs !== undefined && elapsedMs >= options.slowMs) {
        logger.warn(`SLOW ${msg}`);
      } else {
        logger[level](msg);
      }
    };

    return function (this: object, ...args: unknown[]) {
      const start = performance.now();
      const logger = getLogger(this);
      try {
        const res = orig.apply(this, args);
        if (res && typeof (res as PromiseLike<unknown>).then === "function") {
          return Promise.resolve(res).then(
            (resolved) => {
              emitSuccess(logger, performance.now() - start, args, resolved);
              return resolved;
            },
            (err) => {
              const elapsed = performance.now() - start;
              logger.error(
                `${ctorName}.${String(methodName)} failed after ${elapsed.toFixed(1)}ms: ${err instanceof Error ? err.message : String(err)}`,
              );
              throw err;
            },
          );
        }
        emitSuccess(logger, performance.now() - start, args, res);
        return res;
      } catch (err) {
        const elapsed = performance.now() - start;
        logger.error(
          `${ctorName}.${String(methodName)} failed after ${elapsed.toFixed(1)}ms: ${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      }
    };
  };

  return tagMacroDecorator(
    ((
      target: object,
      propertyKey?: string | symbol,
      descriptor?: PropertyDescriptor,
    ): PropertyDescriptor | void => {
      if (propertyKey !== undefined && descriptor) {
        const orig = descriptor.value as (...args: unknown[]) => unknown;
        if (typeof orig === "function") {
          descriptor.value = wrapMethod(
            target.constructor.name,
            propertyKey,
            orig,
          );
        }
        return descriptor;
      }

      const ctor = target as Function;
      const proto = ctor.prototype as Record<string, unknown>;
      for (const key of Object.getOwnPropertyNames(proto)) {
        if (key === "constructor") continue;
        const desc = Object.getOwnPropertyDescriptor(proto, key);
        if (desc && typeof desc.value === "function") {
          Object.defineProperty(proto, key, {
            ...desc,
            value: wrapMethod(
              ctor.name,
              key,
              desc.value as (...args: unknown[]) => unknown,
            ),
          });
        }
      }
    }) as ClassDecorator & MethodDecorator,
    "LogExecution",
  );
}
