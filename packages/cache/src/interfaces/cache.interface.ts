import type {
  ExecutionContext,
  FactoryDependency,
  InjectionToken,
  ModuleImport,
  Provider,
  Type,
} from "@bunest/core";

export interface CacheSetOptions {
  /**
   * Time-to-live in milliseconds. Omit or pass `0` to use store default (or no expiry if default is 0).
   */
  ttlMs?: number;
  /**
   * Alias for `ttlMs` matching `@nestjs/cache-manager` / `cache-manager`.
   */
  ttl?: number;
  /**
   * Optional invalidation tags associated with this key.
   */
  tags?: readonly string[];
}

export type CacheTtlOrOptions = number | CacheSetOptions;

export interface CacheMsetItem<T = unknown> {
  readonly key: string;
  readonly value: T;
  readonly ttl?: number;
}

export type CacheMsetTuple = readonly [string, unknown, CacheTtlOrOptions?];

export type CacheMsetInput<T = unknown> =
  ReadonlyArray<CacheMsetTuple> | ReadonlyArray<CacheMsetItem<T>>;

export interface CacheWrapOptions<T = unknown> {
  ttl?: number | ((value: T) => number);
  ttlMs?: number;
  tags?: readonly string[];
  refreshThreshold?: number | ((value: T) => number);
}

export type CacheEventName =
  "get" | "mget" | "set" | "mset" | "del" | "mdel" | "clear" | "refresh";

export type CacheEventListener = (...args: any[]) => void;

/**
 * Pluggable cache store contract implemented by `MemoryCacheStore`,
 * `RedisCacheStore`, or custom backends.
 */
export interface CacheStore {
  get<T = unknown>(key: string): Promise<T | undefined> | T | undefined;
  set<T = unknown>(
    key: string,
    value: T,
    ttlMsOrOptions?: CacheTtlOrOptions,
  ): Promise<void> | void;
  del(key: string): Promise<boolean> | boolean;
  has(key: string): Promise<boolean> | boolean;
  reset(): Promise<void> | void;
  /**
   * Returns remaining time-to-live in milliseconds for `key`, or `null` if the
   * key does not exist or has no expiration.
   */
  ttl?(key: string): Promise<number | null> | number | null;
  keys?(prefix?: string): Promise<string[]> | string[];
  mget?<T = unknown>(
    keys: readonly string[],
  ): Promise<Array<T | undefined>> | Array<T | undefined>;
  mset?(
    entries: ReadonlyArray<readonly [string, unknown, CacheTtlOrOptions?]>,
  ): Promise<void> | void;
  mdel?(keys: readonly string[]): Promise<number> | number;
  deleteByPrefix?(prefix: string): Promise<number> | number;
  invalidateTag?(tag: string): Promise<number> | number;
  close?(): Promise<void> | void;
  disconnect?(): Promise<void> | void;
}

/**
 * Configuration options matching `@nestjs/cache-manager` `CacheManagerOptions`.
 */
export interface CacheManagerOptions {
  /**
   * One or more layered cache stores (e.g. L1 memory -> L2 Redis).
   */
  stores?: CacheStore | readonly CacheStore[];
  /**
   * Optional key namespace prefix applied automatically to all cache operations.
   */
  namespace?: string;
  /**
   * Default time-to-live in milliseconds (alias for `ttlMs`).
   */
  ttl?: number;
  /**
   * Stale-while-revalidate threshold in milliseconds. When `wrap()` hits an
   * entry whose remaining TTL is below `refreshThreshold`, the cached value is
   * returned immediately while a background refresh updates the store(s).
   */
  refreshThreshold?: number;
  /**
   * When true with multiple stores, secondary store writes/deletes run
   * asynchronously without blocking the returned promise.
   * @default false
   */
  nonBlocking?: boolean;
  /**
   * When true, background refreshes triggered by `refreshThreshold` write to
   * every configured store rather than only up to the store that served the hit.
   * @default false
   */
  refreshAllStores?: boolean;
  /**
   * Unique identifier for this cache instance (defaults to a generated UUID).
   */
  cacheId?: string;
}

export type CacheOptions<
  StoreConfig extends Record<PropertyKey, unknown> = Record<string, unknown>,
> = CacheManagerOptions & StoreConfig;

export type CacheModuleOptions<
  StoreConfig extends Record<PropertyKey, unknown> = Record<string, unknown>,
> = CacheOptions<StoreConfig> & {
  /**
   * Custom `CacheStore` instance. Defaults to `MemoryCacheStore`.
   */
  store?: CacheStore;
  /**
   * Default TTL in milliseconds for `MemoryCacheStore` (alias of `ttl`).
   * @default 0 (no default expiration)
   */
  ttlMs?: number;
  /**
   * Maximum items held by default `MemoryCacheStore` before LRU eviction.
   * @default 1000
   */
  maxItems?: number;
  /**
   * Optional periodic expired-entry sweep interval for `MemoryCacheStore` (ms; 0 disables).
   */
  cleanupIntervalMs?: number;
  /**
   * Registers `CacheModule` globally across all modules.
   * @default false
   */
  isGlobal?: boolean;
};

export interface CacheOptionsFactory<
  StoreConfig extends Record<PropertyKey, unknown> = Record<string, unknown>,
> {
  createCacheOptions():
    CacheModuleOptions<StoreConfig> | Promise<CacheModuleOptions<StoreConfig>>;
}

export interface CacheModuleAsyncOptions<
  StoreConfig extends Record<PropertyKey, unknown> = Record<string, unknown>,
> {
  isGlobal?: boolean;
  imports?: ModuleImport[];
  useFactory?: (
    ...args: any[]
  ) =>
    CacheModuleOptions<StoreConfig> | Promise<CacheModuleOptions<StoreConfig>>;
  inject?: FactoryDependency[];
  useClass?: Type<CacheOptionsFactory<StoreConfig>>;
  useExisting?: InjectionToken<CacheOptionsFactory<StoreConfig>>;
  /**
   * Extra providers registered within the scope of `CacheModule`.
   */
  extraProviders?: Provider[];
  /**
   * Additional providers whose injection tokens should be available to `useFactory`.
   */
  provideInjectionTokensFrom?: Provider[];
}

export type CacheKeyFactory = (
  context: ExecutionContext,
) => string | Promise<string | undefined> | undefined;

export type CacheKeyMetadataValue = string | CacheKeyFactory;

export type CacheTTLFactory = (
  ctx: ExecutionContext,
) => Promise<number> | number;

export type CacheTtlMetadataValue = number | CacheTTLFactory;
