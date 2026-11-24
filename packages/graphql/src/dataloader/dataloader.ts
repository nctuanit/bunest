export type BatchLoadFn<K, V> = (
  keys: readonly K[],
) => Promise<ReadonlyArray<V | Error>> | ReadonlyArray<V | Error>;

export interface BunestDataLoaderOptions<K, C = K> {
  /**
   * Coalesce `load()` calls within the same microtask tick into a single batch.
   * @default true
   */
  readonly batch?: boolean;
  /**
   * Maximum number of keys per batch invocation.
   * @default Infinity
   */
  readonly maxBatchSize?: number;
  /**
   * Memoize loaded promises per key for the lifetime of this DataLoader instance
   * (typically one GraphQL request).
   * @default true
   */
  readonly cache?: boolean;
  /**
   * Optional key normalization function for cache lookup (useful for object keys).
   */
  readonly cacheKeyFn?: (key: K) => C;
  /**
   * Custom batch scheduling function.
   * @default queueMicrotask
   */
  readonly batchScheduleFn?: (callback: () => void) => void;
}

interface PendingBatchEntry<K, V> {
  readonly key: K;
  readonly resolve: (value: V) => void;
  readonly reject: (reason: unknown) => void;
}

/**
 * Request-scoped, microtask-batched, per-request cached DataLoader eliminating
 * GraphQL N+1 queries with zero external dependencies.
 */
export class BunestDataLoader<K, V, C = K> {
  private readonly batchEnabled: boolean;
  private readonly maxBatchSize: number;
  private readonly cacheEnabled: boolean;
  private readonly cacheKeyFn: (key: K) => C;
  private readonly batchScheduleFn: (callback: () => void) => void;

  private readonly cacheMap = new Map<C, Promise<V>>();
  private queue: PendingBatchEntry<K, V>[] = [];
  private dispatchScheduled = false;

  constructor(
    private readonly batchLoadFn: BatchLoadFn<K, V>,
    options: BunestDataLoaderOptions<K, C> = {},
  ) {
    this.batchEnabled = options.batch ?? true;
    this.maxBatchSize =
      options.maxBatchSize !== undefined && options.maxBatchSize > 0
        ? Math.floor(options.maxBatchSize)
        : Number.POSITIVE_INFINITY;
    this.cacheEnabled = options.cache ?? true;
    this.cacheKeyFn = options.cacheKeyFn ?? ((key: K) => key as unknown as C);
    this.batchScheduleFn = options.batchScheduleFn ?? queueMicrotask;
  }

  /**
   * Loads a single key, returning a cached promise if already requested in this
   * loader scope or coalescing into the current microtask batch.
   */
  load(key: K): Promise<V> {
    const cacheKey = this.cacheKeyFn(key);
    if (this.cacheEnabled) {
      const cached = this.cacheMap.get(cacheKey);
      if (cached !== undefined) {
        return cached;
      }
    }

    const promise = new Promise<V>((resolve, reject) => {
      if (!this.batchEnabled) {
        void this.dispatchBatch([{ key, resolve, reject }]);
        return;
      }

      this.queue.push({ key, resolve, reject });
      if (!this.dispatchScheduled) {
        this.dispatchScheduled = true;
        this.batchScheduleFn(() => {
          this.flushQueue();
        });
      }
    });

    if (this.cacheEnabled) {
      this.cacheMap.set(cacheKey, promise);
    }

    return promise;
  }

  /**
   * Loads multiple keys in a single batch, resolving per-key errors as values
   * so one failed key does not reject the entire array.
   */
  async loadMany(keys: readonly K[]): Promise<Array<V | Error>> {
    const promises = keys.map((key) =>
      this.load(key).catch((err) =>
        err instanceof Error ? err : new Error(String(err)),
      ),
    );
    return await Promise.all(promises);
  }

  /**
   * Evicts a single key from the per-request cache.
   */
  clear(key: K): this {
    this.cacheMap.delete(this.cacheKeyFn(key));
    return this;
  }

  /**
   * Evicts all cached keys from this loader instance.
   */
  clearAll(): this {
    this.cacheMap.clear();
    return this;
  }

  /**
   * Pre-populates the cache for `key` if not already cached.
   */
  prime(key: K, value: V | Error): this {
    const cacheKey = this.cacheKeyFn(key);
    if (this.cacheEnabled && !this.cacheMap.has(cacheKey)) {
      const promise =
        value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
      if (value instanceof Error) {
        // Prevent unhandled rejection before consumer calls load(key)
        promise.catch(() => {});
      }
      this.cacheMap.set(cacheKey, promise);
    }
    return this;
  }

  private flushQueue(): void {
    this.dispatchScheduled = false;
    const pending = this.queue;
    this.queue = [];
    if (pending.length === 0) {
      return;
    }

    if (pending.length <= this.maxBatchSize) {
      void this.dispatchBatch(pending);
      return;
    }

    for (let i = 0; i < pending.length; i += this.maxBatchSize) {
      void this.dispatchBatch(pending.slice(i, i + this.maxBatchSize));
    }
  }

  private async dispatchBatch(
    batch: readonly PendingBatchEntry<K, V>[],
  ): Promise<void> {
    const keys = batch.map((entry) => entry.key);

    let values: ReadonlyArray<V | Error>;
    try {
      values = await this.batchLoadFn(keys);
    } catch (err) {
      for (const entry of batch) {
        entry.reject(err);
      }
      return;
    }

    if (!Array.isArray(values)) {
      const err = new TypeError(
        `BunestDataLoader batchLoadFn must return an Array matching keys length (${keys.length}).`,
      );
      for (const entry of batch) {
        entry.reject(err);
      }
      return;
    }

    if (values.length !== batch.length) {
      const err = new TypeError(
        `BunestDataLoader batchLoadFn returned ${values.length} results for ${batch.length} keys.`,
      );
      for (const entry of batch) {
        entry.reject(err);
      }
      return;
    }

    for (let i = 0; i < batch.length; i++) {
      const entry = batch[i]!;
      const val = values[i]!;
      if (val instanceof Error) {
        entry.reject(val);
      } else {
        entry.resolve(val);
      }
    }
  }
}
