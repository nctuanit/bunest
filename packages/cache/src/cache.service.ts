import {
  Inject,
  Injectable,
  Optional,
  type OnApplicationShutdown,
} from "@bunest/core";
import { Cache } from "./cache.abstract";
import { CACHE_MODULE_OPTIONS, CACHE_STORE } from "./constants";
import type {
  CacheEventListener,
  CacheEventName,
  CacheModuleOptions,
  CacheMsetInput,
  CacheMsetItem,
  CacheMsetTuple,
  CacheSetOptions,
  CacheStore,
  CacheTtlOrOptions,
  CacheWrapOptions,
} from "./interfaces/cache.interface";
import { MemoryCacheStore } from "./stores/memory-cache.store";

function isMsetObjectItem(item: unknown): item is CacheMsetItem {
  return (
    typeof item === "object" &&
    item !== null &&
    !Array.isArray(item) &&
    "key" in item
  );
}

function isWrapOptionsObject<T>(value: unknown): value is CacheWrapOptions<T> {
  return typeof value === "object" && value !== null;
}

/**
 * High-level cache service implementing the NestJS `Cache` facade contract:
 * multi-tier L1/L2 `stores`, `namespace` prefixing, `ttl` / `ttlMs` defaults,
 * `refreshThreshold` stale-while-revalidate, lifecycle events (`on`/`off`),
 * single-flight `wrap()` deduplication, prefix & tag invalidation, and clean
 * `disconnect()` teardown.
 */
@Injectable()
export class CacheService extends Cache implements OnApplicationShutdown {
  public override readonly stores: readonly CacheStore[];

  private readonly defaultTtlMs?: number;
  private readonly namespace?: string;
  private readonly defaultRefreshThreshold?: number;
  private readonly nonBlocking: boolean;
  private readonly refreshAllStores: boolean;
  private readonly instanceId: string;
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly inFlightRefresh = new Map<string, Promise<void>>();
  private readonly eventListeners = new Map<string, Set<CacheEventListener>>();

  constructor(
    @Optional()
    @Inject(CACHE_STORE)
    store?: CacheStore,
    @Optional()
    @Inject(CACHE_MODULE_OPTIONS)
    options: CacheModuleOptions = {},
  ) {
    super();

    const effectiveDefaultTtl =
      options.ttl !== undefined ? options.ttl : options.ttlMs;
    this.defaultTtlMs = effectiveDefaultTtl;
    this.namespace = options.namespace;
    this.defaultRefreshThreshold = options.refreshThreshold;
    this.nonBlocking = options.nonBlocking ?? false;
    this.refreshAllStores = options.refreshAllStores ?? false;
    this.instanceId = options.cacheId ?? crypto.randomUUID();

    if (Array.isArray(options.stores) && options.stores.length > 0) {
      this.stores = [...options.stores];
    } else if (options.stores && !Array.isArray(options.stores)) {
      this.stores = [options.stores as CacheStore];
    } else if (store) {
      this.stores = [store];
    } else if (options.store) {
      this.stores = [options.store];
    } else {
      this.stores = [
        new MemoryCacheStore({
          defaultTtlMs: effectiveDefaultTtl,
          maxItems: options.maxItems,
          cleanupIntervalMs: options.cleanupIntervalMs,
        }),
      ];
    }
  }

  getStore(): CacheStore {
    return this.stores[0]!;
  }

  override cacheId(): string {
    return this.instanceId;
  }

  override on(
    event: CacheEventName | string,
    listener: CacheEventListener,
  ): this {
    let set = this.eventListeners.get(event);
    if (!set) {
      set = new Set();
      this.eventListeners.set(event, set);
    }
    set.add(listener);
    return this;
  }

  override off(
    event: CacheEventName | string,
    listener: CacheEventListener,
  ): this {
    const set = this.eventListeners.get(event);
    if (set) {
      set.delete(listener);
      if (set.size === 0) {
        this.eventListeners.delete(event);
      }
    }
    return this;
  }

  override async get<T = unknown>(key: string): Promise<T | undefined> {
    const fullKey = this.formatKey(key);
    for (let i = 0; i < this.stores.length; i += 1) {
      const store = this.stores[i]!;
      try {
        const value = await store.get<T>(fullKey);
        if (value !== undefined) {
          if (i > 0) {
            const remaining =
              typeof store.ttl === "function" ? await store.ttl(fullKey) : null;
            const backfillTtl =
              remaining !== null && remaining > 0
                ? remaining
                : this.defaultTtlMs;
            const backfill = Promise.all(
              this.stores
                .slice(0, i)
                .map((s) => s.set(fullKey, value, backfillTtl)),
            ).catch(() => {});
            if (!this.nonBlocking) {
              await backfill;
            }
          }
          this.emitEvent("get", { key, value });
          return value;
        }
      } catch (error) {
        this.emitEvent("get", { key, error });
      }
    }
    this.emitEvent("get", { key, value: undefined });
    return undefined;
  }

  override async ttl(key: string): Promise<number | null> {
    const fullKey = this.formatKey(key);
    for (const store of this.stores) {
      if (typeof store.ttl !== "function") {
        continue;
      }
      const remaining = await store.ttl(fullKey);
      if (remaining !== null && remaining !== undefined) {
        return remaining;
      }
    }
    return null;
  }

  override async set<T = unknown>(
    key: string,
    value: T,
    ttlMsOrOptions?: CacheTtlOrOptions,
  ): Promise<T> {
    const fullKey = this.formatKey(key);
    const effectiveOptions = this.applyDefaultTtl(ttlMsOrOptions);

    try {
      await this.writeAcrossStores(
        this.stores,
        fullKey,
        value,
        effectiveOptions,
      );
      this.emitEvent("set", { key, value });
      return value;
    } catch (error) {
      this.emitEvent("set", { key, value, error });
      throw error;
    }
  }

  override async del(key: string): Promise<boolean> {
    const fullKey = this.formatKey(key);
    try {
      if (this.nonBlocking && this.stores.length > 1) {
        const primary = await this.stores[0]!.del(fullKey);
        void Promise.all(this.stores.slice(1).map((s) => s.del(fullKey))).catch(
          () => {},
        );
        this.emitEvent("del", { key });
        return primary;
      }
      const results = await Promise.all(
        this.stores.map((store) => store.del(fullKey)),
      );
      this.emitEvent("del", { key });
      return results.some(Boolean);
    } catch (error) {
      this.emitEvent("del", { key, error });
      throw error;
    }
  }

  async has(key: string): Promise<boolean> {
    const fullKey = this.formatKey(key);
    for (const store of this.stores) {
      if (await store.has(fullKey)) {
        return true;
      }
    }
    return false;
  }

  async reset(): Promise<void> {
    await this.clear();
  }

  override async clear(): Promise<boolean> {
    try {
      if (this.nonBlocking && this.stores.length > 1) {
        await this.stores[0]!.reset();
        void Promise.all(this.stores.slice(1).map((s) => s.reset())).catch(
          () => {},
        );
      } else {
        await Promise.all(this.stores.map((store) => store.reset()));
      }
      this.emitEvent("clear");
      return true;
    } catch (error) {
      this.emitEvent("clear", error);
      throw error;
    }
  }

  async keys(prefix?: string): Promise<string[]> {
    const fullPrefix = this.formatPrefix(prefix);
    const keySet = new Set<string>();
    for (const store of this.stores) {
      if (typeof store.keys !== "function") {
        continue;
      }
      const list = await store.keys(fullPrefix);
      for (const rawKey of list) {
        keySet.add(this.stripNamespace(rawKey));
      }
    }
    return [...keySet];
  }

  override async mget<T = unknown>(
    keys: readonly string[],
  ): Promise<Array<T | undefined>> {
    if (keys.length === 0) {
      this.emitEvent("mget", { keys: [], value: [] });
      return [];
    }

    const result: Array<T | undefined> = keys.map(() => undefined);
    const fullKeys = keys.map((k) => this.formatKey(k));

    for (const store of this.stores) {
      const missingIndices: number[] = [];
      const missingKeys: string[] = [];
      for (let i = 0; i < result.length; i += 1) {
        if (result[i] === undefined) {
          missingIndices.push(i);
          missingKeys.push(fullKeys[i]!);
        }
      }
      if (missingIndices.length === 0) {
        break;
      }

      const values =
        typeof store.mget === "function"
          ? await store.mget<T>(missingKeys)
          : await Promise.all(missingKeys.map((k) => store.get<T>(k)));

      for (let j = 0; j < values.length; j += 1) {
        const val = values[j];
        if (val !== undefined) {
          result[missingIndices[j]!] = val;
        }
      }
    }

    this.emitEvent("mget", { keys: [...keys], value: result });
    return result;
  }

  override async mset<T = unknown>(entries: CacheMsetInput<T>): Promise<void> {
    const normalizedTuples: CacheMsetTuple[] = entries.map((entry) => {
      if (isMsetObjectItem(entry)) {
        return [
          this.formatKey(entry.key),
          entry.value,
          this.applyDefaultTtl(entry.ttl),
        ] as const;
      }
      const [key, value, opts] = entry as CacheMsetTuple;
      return [this.formatKey(key), value, this.applyDefaultTtl(opts)] as const;
    });

    const emitList = entries.map((entry) =>
      isMsetObjectItem(entry)
        ? { key: entry.key, value: entry.value, ttl: entry.ttl }
        : {
            key: (entry as CacheMsetTuple)[0],
            value: (entry as CacheMsetTuple)[1],
            ttl:
              typeof (entry as CacheMsetTuple)[2] === "number"
                ? ((entry as CacheMsetTuple)[2] as number)
                : ((entry as CacheMsetTuple)[2] as CacheSetOptions | undefined)
                    ?.ttlMs,
          },
    );

    try {
      const writeStore = async (store: CacheStore) => {
        if (typeof store.mset === "function") {
          await store.mset(normalizedTuples);
          return;
        }
        for (const [key, value, opts] of normalizedTuples) {
          await store.set(key, value, opts);
        }
      };

      if (this.nonBlocking && this.stores.length > 1) {
        await writeStore(this.stores[0]!);
        void Promise.all(this.stores.slice(1).map((s) => writeStore(s))).catch(
          () => {},
        );
      } else {
        await Promise.all(this.stores.map((s) => writeStore(s)));
      }
      this.emitEvent("mset", { list: emitList });
    } catch (error) {
      this.emitEvent("mset", { list: emitList, error });
      throw error;
    }
  }

  override async mdel(keys: readonly string[]): Promise<number> {
    if (keys.length === 0) {
      return 0;
    }
    const fullKeys = keys.map((k) => this.formatKey(k));
    const deleteFromStore = async (store: CacheStore): Promise<number> => {
      if (typeof store.mdel === "function") {
        return await store.mdel(fullKeys);
      }
      let count = 0;
      for (const k of fullKeys) {
        if (await store.del(k)) {
          count += 1;
        }
      }
      return count;
    };

    if (this.nonBlocking && this.stores.length > 1) {
      const primaryCount = await deleteFromStore(this.stores[0]!);
      void Promise.all(
        this.stores.slice(1).map((s) => deleteFromStore(s)),
      ).catch(() => {});
      this.emitEvent("mdel", { keys: [...keys] });
      return primaryCount;
    }

    const counts = await Promise.all(
      this.stores.map((store) => deleteFromStore(store)),
    );
    this.emitEvent("mdel", { keys: [...keys] });
    return Math.max(0, ...counts);
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    const fullPrefix = this.formatPrefix(prefix) ?? "";
    const counts = await Promise.all(
      this.stores.map(async (store) => {
        if (typeof store.deleteByPrefix === "function") {
          return await store.deleteByPrefix(fullPrefix);
        }
        if (typeof store.keys === "function") {
          const matching = await store.keys(fullPrefix);
          if (typeof store.mdel === "function") {
            return await store.mdel(matching);
          }
          let count = 0;
          for (const k of matching) {
            if (await store.del(k)) {
              count += 1;
            }
          }
          return count;
        }
        return 0;
      }),
    );
    return Math.max(0, ...counts);
  }

  async invalidateTag(tag: string): Promise<number> {
    const counts = await Promise.all(
      this.stores.map(async (store) =>
        typeof store.invalidateTag === "function"
          ? await store.invalidateTag(tag)
          : 0,
      ),
    );
    return Math.max(0, ...counts);
  }

  /**
   * Fetches `key` from cache, or computes it via `factory` on cache miss with
   * single-flight stampede deduplication so concurrent misses invoke `factory`
   * only once. Supports `refreshThreshold` background stale-while-revalidate.
   */
  override async wrap<T>(
    key: string,
    factory: () => T | Promise<T>,
    ttlOrOptions?:
      CacheTtlOrOptions | ((value: T) => number) | CacheWrapOptions<T>,
    refreshThresholdArg?: number | ((value: T) => number),
  ): Promise<T> {
    const fullKey = this.formatKey(key);

    // Resolve hit across layered stores, tracking which tier served the hit
    let hitValue: T | undefined;
    let hitStoreIndex = -1;
    let remainingTtl: number | null = null;

    for (let i = 0; i < this.stores.length; i += 1) {
      const store = this.stores[i]!;
      const value = await store.get<T>(fullKey);
      if (value !== undefined) {
        hitValue = value;
        hitStoreIndex = i;
        if (typeof store.ttl === "function") {
          remainingTtl = await store.ttl(fullKey);
        }
        break;
      }
    }

    const resolveSetOptions = (computed: T): CacheTtlOrOptions | undefined => {
      if (typeof ttlOrOptions === "function") {
        return this.applyDefaultTtl(ttlOrOptions(computed));
      }
      if (typeof ttlOrOptions === "number") {
        return ttlOrOptions;
      }
      if (isWrapOptionsObject<T>(ttlOrOptions)) {
        const rawTtl =
          typeof ttlOrOptions.ttl === "function"
            ? ttlOrOptions.ttl(computed)
            : (ttlOrOptions.ttl ?? ttlOrOptions.ttlMs);
        const setOpts: CacheSetOptions = {
          ...(rawTtl !== undefined ? { ttlMs: rawTtl } : {}),
          ...(ttlOrOptions.tags ? { tags: ttlOrOptions.tags } : {}),
        };
        return this.applyDefaultTtl(setOpts);
      }
      return this.applyDefaultTtl(undefined);
    };

    const resolveRefreshThreshold = (value: T): number | undefined => {
      const candidate =
        isWrapOptionsObject<T>(ttlOrOptions) &&
        ttlOrOptions.refreshThreshold !== undefined
          ? ttlOrOptions.refreshThreshold
          : refreshThresholdArg;
      if (typeof candidate === "function") {
        return candidate(value);
      }
      return candidate ?? this.defaultRefreshThreshold;
    };

    if (hitValue !== undefined) {
      const threshold = resolveRefreshThreshold(hitValue);
      const shouldRefresh =
        threshold !== undefined &&
        threshold > 0 &&
        remainingTtl !== null &&
        remainingTtl < threshold;

      if (shouldRefresh) {
        this.scheduleBackgroundRefresh(
          key,
          fullKey,
          hitValue,
          hitStoreIndex,
          factory,
          resolveSetOptions,
        );
      } else if (hitStoreIndex > 0) {
        const backfillOpts =
          remainingTtl !== null && remainingTtl > 0
            ? remainingTtl
            : resolveSetOptions(hitValue);
        const backfill = this.writeAcrossStores(
          this.stores.slice(0, hitStoreIndex),
          fullKey,
          hitValue,
          backfillOpts,
        ).catch(() => {});
        if (!this.nonBlocking) {
          await backfill;
        }
      }

      return hitValue;
    }

    const existingFlight = this.inFlight.get(fullKey);
    if (existingFlight !== undefined) {
      return (await existingFlight) as T;
    }

    const flight = (async (): Promise<T> => {
      const computed = await factory();
      if (computed !== undefined) {
        await this.writeAcrossStores(
          this.stores,
          fullKey,
          computed,
          resolveSetOptions(computed),
        );
        this.emitEvent("set", { key, value: computed });
      }
      return computed;
    })();

    this.inFlight.set(fullKey, flight);
    try {
      return await flight;
    } finally {
      this.inFlight.delete(fullKey);
    }
  }

  override async disconnect(): Promise<void> {
    this.inFlight.clear();
    this.inFlightRefresh.clear();
    await Promise.all(
      this.stores.map(async (store) => {
        if (typeof store.close === "function") {
          await store.close();
        } else if (typeof store.disconnect === "function") {
          await store.disconnect();
        }
      }),
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await this.disconnect();
  }

  private scheduleBackgroundRefresh<T>(
    key: string,
    fullKey: string,
    previousValue: T,
    hitStoreIndex: number,
    factory: () => T | Promise<T>,
    resolveSetOptions: (computed: T) => CacheTtlOrOptions | undefined,
  ): void {
    if (this.inFlightRefresh.has(fullKey)) {
      return;
    }

    const targetStores = this.refreshAllStores
      ? this.stores
      : this.stores.slice(0, hitStoreIndex + 1);

    const refreshTask = (async () => {
      try {
        const fresh = await factory();
        if (fresh !== undefined) {
          await this.writeAcrossStores(
            targetStores,
            fullKey,
            fresh,
            resolveSetOptions(fresh),
          );
          this.emitEvent("refresh", { key, value: fresh });
        }
      } catch (error) {
        this.emitEvent("refresh", { key, value: previousValue, error });
      } finally {
        this.inFlightRefresh.delete(fullKey);
      }
    })();

    this.inFlightRefresh.set(fullKey, refreshTask);
  }

  private async writeAcrossStores<T>(
    targetStores: readonly CacheStore[],
    fullKey: string,
    value: T,
    opts?: CacheTtlOrOptions,
  ): Promise<void> {
    if (this.nonBlocking && targetStores.length > 1) {
      await targetStores[0]!.set(fullKey, value, opts);
      void Promise.all(
        targetStores.slice(1).map((s) => s.set(fullKey, value, opts)),
      ).catch(() => {});
      return;
    }
    await Promise.all(targetStores.map((s) => s.set(fullKey, value, opts)));
  }

  private applyDefaultTtl(
    ttlMsOrOptions?: CacheTtlOrOptions,
  ): CacheTtlOrOptions | undefined {
    if (ttlMsOrOptions === undefined) {
      return this.defaultTtlMs;
    }
    if (typeof ttlMsOrOptions === "number") {
      return ttlMsOrOptions;
    }
    const explicitTtl =
      ttlMsOrOptions.ttlMs !== undefined
        ? ttlMsOrOptions.ttlMs
        : ttlMsOrOptions.ttl;
    if (explicitTtl !== undefined) {
      return { ...ttlMsOrOptions, ttlMs: explicitTtl };
    }
    if (this.defaultTtlMs !== undefined) {
      return { ...ttlMsOrOptions, ttlMs: this.defaultTtlMs };
    }
    return ttlMsOrOptions;
  }

  private formatKey(key: string): string {
    return this.namespace ? `${this.namespace}:${key}` : key;
  }

  private formatPrefix(prefix?: string): string | undefined {
    if (!this.namespace) {
      return prefix;
    }
    return `${this.namespace}:${prefix ?? ""}`;
  }

  private stripNamespace(rawKey: string): string {
    if (!this.namespace) {
      return rawKey;
    }
    const nsPrefix = `${this.namespace}:`;
    return rawKey.startsWith(nsPrefix) ? rawKey.slice(nsPrefix.length) : rawKey;
  }

  private emitEvent(event: string, payload?: unknown): void {
    const listeners = this.eventListeners.get(event);
    if (!listeners || listeners.size === 0) {
      return;
    }
    for (const listener of [...listeners]) {
      try {
        if (payload !== undefined) {
          listener(payload);
        } else {
          listener();
        }
      } catch {
        // Cache lifecycle observers must not break cache operations
      }
    }
  }
}
