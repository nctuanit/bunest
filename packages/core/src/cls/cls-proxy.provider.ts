import type {
  FactoryDependency,
  FactoryProvider,
  InjectionToken,
} from "../common/index";
import { formatToken } from "../errors/token-formatter";
import { ClsService } from "./cls.service";

export const CLS_PROXY_MARKER = Symbol.for("bunest:core:cls_proxy");

export type ClsProxyFactory<T extends object = object> = (
  cls: ClsService,
  ...deps: any[]
) => T;

export interface ClsProxyProviderOptions {
  /**
   * Additional DI tokens injected into `factory` after `ClsService`.
   */
  readonly inject?: readonly FactoryDependency[];
  /**
   * Explicit CLS store key under which the resolved per-context target instance
   * is cached. Defaults to a unique `Symbol` per proxy provider.
   */
  readonly storeKey?: string | symbol;
  /**
   * When `true` (default), caches the object returned by `factory` in the active
   * CLS store so repeated accesses within the same CLS context share one instance.
   * When `false`, invokes `factory(cls, ...deps)` on every proxy operation.
   * @default true
   */
  readonly cache?: boolean;
}

const INACTIVE_SAFE_PROPS = new Set<string | symbol>([
  "then",
  "catch",
  "finally",
  "onModuleInit",
  "onApplicationBootstrap",
  "onModuleDestroy",
  "beforeApplicationShutdown",
  "onApplicationShutdown",
  "onRequestDestroy",
  Symbol.toPrimitive,
  Symbol.iterator,
  Symbol.asyncIterator,
  Symbol.dispose,
  Symbol.asyncDispose,
]);

const THENABLE_PROPS = new Set<string | symbol>(["then", "catch", "finally"]);

/**
 * Creates a singleton `FactoryProvider<T>` backed by a zero-dependency JS `Proxy`
 * that lazily resolves and caches a per-CLS-context object on demand.
 *
 * Allows singleton services to inject typed request/tenant/transaction proxies
 * without introducing `Scope.REQUEST` chains or violating ADR-012.
 */
export function createClsProxyProvider<T extends object>(
  token: InjectionToken<T>,
  factory: ClsProxyFactory<T>,
  options: ClsProxyProviderOptions = {},
): FactoryProvider<T> {
  const tokenLabel = formatToken(token);
  const storeKey = options.storeKey ?? Symbol(`bunest:cls:proxy:${tokenLabel}`);
  const shouldCache = options.cache !== false;
  const extraInject = options.inject ? [...options.inject] : [];

  return {
    provide: token,
    inject: [{ token: ClsService, optional: true }, ...extraInject],
    useFactory: (
      injectedCls: ClsService | undefined,
      ...deps: unknown[]
    ): T => {
      const cls = injectedCls ?? new ClsService();
      const dummyTarget = Object.create(null) as Record<PropertyKey, unknown>;

      const resolveTarget = (): T => {
        if (!cls.isActive()) {
          throw new Error(
            `CLS proxy provider "${tokenLabel}" was accessed outside an active CLS context. Wrap execution in cls.run(), ClsMiddleware, ClsInterceptor, or @WithCls().`,
          );
        }

        if (shouldCache && cls.has(storeKey)) {
          const cached = cls.get<T>(storeKey);
          if (cached !== undefined && cached !== null) {
            return cached;
          }
        }

        const created = factory(cls, ...deps);
        if (
          created === null ||
          created === undefined ||
          (typeof created !== "object" && typeof created !== "function")
        ) {
          throw new Error(
            `CLS proxy provider "${tokenLabel}" factory did not return an object in the current CLS context.`,
          );
        }

        if (shouldCache) {
          cls.set(storeKey, created);
        }
        return created;
      };

      return new Proxy(dummyTarget as unknown as T, {
        get(_target, prop) {
          if (prop === CLS_PROXY_MARKER) {
            return true;
          }
          if (!cls.isActive()) {
            if (prop === Symbol.toStringTag) {
              return "ClsProxy";
            }
            if (prop === "constructor") {
              return typeof token === "function" ? token : Object;
            }
            if (INACTIVE_SAFE_PROPS.has(prop) || typeof prop === "symbol") {
              return undefined;
            }
            // Fall through to resolveTarget() to throw an actionable context error
          }
          if (THENABLE_PROPS.has(prop)) {
            return undefined;
          }
          const resolved = resolveTarget();
          const value = Reflect.get(resolved, prop, resolved);
          if (typeof value === "function") {
            return (value as Function).bind(resolved);
          }
          return value;
        },

        set(_target, prop, value) {
          const resolved = resolveTarget();
          return Reflect.set(resolved, prop, value, resolved);
        },

        has(_target, prop) {
          if (prop === CLS_PROXY_MARKER) {
            return true;
          }
          if (!cls.isActive()) {
            return false;
          }
          return Reflect.has(resolveTarget(), prop);
        },

        deleteProperty(_target, prop) {
          const resolved = resolveTarget();
          return Reflect.deleteProperty(resolved, prop);
        },

        ownKeys() {
          if (!cls.isActive()) {
            return [];
          }
          return Reflect.ownKeys(resolveTarget());
        },

        getOwnPropertyDescriptor(_target, prop) {
          if (!cls.isActive()) {
            return undefined;
          }
          const desc = Reflect.getOwnPropertyDescriptor(resolveTarget(), prop);
          if (!desc) {
            return undefined;
          }
          return desc.configurable ? desc : { ...desc, configurable: true };
        },

        getPrototypeOf() {
          if (!cls.isActive()) {
            return typeof token === "function"
              ? (token.prototype as object | null)
              : Object.prototype;
          }
          return Reflect.getPrototypeOf(resolveTarget());
        },
      });
    },
  };
}
