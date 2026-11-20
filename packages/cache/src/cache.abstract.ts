import type {
  CacheEventListener,
  CacheEventName,
  CacheMsetInput,
  CacheStore,
  CacheTtlOrOptions,
  CacheWrapOptions,
} from "./interfaces/cache.interface";

/**
 * Abstract class + DI injection token matching `@nestjs/cache-manager`'s
 * `Cache` class/facade. Implemented by `CacheService`.
 */
export abstract class Cache {
  abstract readonly stores: readonly CacheStore[];

  abstract get<T = unknown>(key: string): Promise<T | undefined>;

  abstract mget<T = unknown>(
    keys: readonly string[],
  ): Promise<Array<T | undefined>>;

  abstract ttl(key: string): Promise<number | null>;

  abstract set<T = unknown>(
    key: string,
    value: T,
    ttlMsOrOptions?: CacheTtlOrOptions,
  ): Promise<T>;

  abstract mset<T = unknown>(entries: CacheMsetInput<T>): Promise<void>;

  abstract del(key: string): Promise<boolean>;

  abstract mdel(keys: readonly string[]): Promise<number>;

  abstract clear(): Promise<boolean>;

  abstract wrap<T>(
    key: string,
    factory: () => T | Promise<T>,
    ttlOrOptions?:
      | CacheTtlOrOptions
      | ((value: T) => number)
      | CacheWrapOptions<T>,
    refreshThreshold?: number | ((value: T) => number),
  ): Promise<T>;

  abstract on(
    event: CacheEventName | string,
    listener: CacheEventListener,
  ): this;

  abstract off(
    event: CacheEventName | string,
    listener: CacheEventListener,
  ): this;

  abstract disconnect(): Promise<void>;

  abstract cacheId(): string;
}
