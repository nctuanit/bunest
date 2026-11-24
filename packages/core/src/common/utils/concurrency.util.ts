import { deferred } from "./async.util";
import { not } from "./predicate.util";
import { isInteger, isNotUndefined } from "./type-guards.util";

/**
 * Counting semaphore controlling access to at most `permits` concurrent async tasks.
 */
export class Semaphore {
  private available: number;
  private readonly queue: Array<() => void> = [];

  constructor(permits: number) {
    if (not(isInteger(permits)) || permits < 1) {
      throw new RangeError(
        `Semaphore: permits must be a positive integer (got ${permits})`,
      );
    }
    this.available = permits;
  }

  /** Number of immediately available permits. */
  get availablePermits(): number {
    return this.available;
  }

  /** Number of callers currently queued waiting for a permit. */
  get waitingCount(): number {
    return this.queue.length;
  }

  /** Acquires a permit and returns a release function (idempotent). */
  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
    } else {
      const waiter = deferred<void>();
      this.queue.push(waiter.resolve);
      await waiter.promise;
    }

    let released = false;
    return (): void => {
      if (released) {
        return;
      }
      released = true;
      const next = this.queue.shift();
      if (isNotUndefined(next)) {
        next();
      } else {
        this.available += 1;
      }
    };
  }

  /** Executes `fn` while holding a permit, guaranteeing release even on error. */
  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/**
 * Binary mutual-exclusion lock (`Semaphore(1)`) serializing critical async sections.
 */
export class Mutex {
  private readonly semaphore = new Semaphore(1);

  /** Whether the mutex is currently held. */
  get isLocked(): boolean {
    return this.semaphore.availablePermits === 0;
  }

  /** Acquires the lock and returns an idempotent unlock function. */
  acquire(): Promise<() => void> {
    return this.semaphore.acquire();
  }

  /** Runs `fn` exclusively under the lock, releasing automatically on completion or throw. */
  run<T>(fn: () => Promise<T> | T): Promise<T> {
    return this.semaphore.run(fn);
  }
}

/**
 * Singleflight / in-flight request deduplicator preventing cache stampedes.
 * Concurrent calls sharing the same `key` await the same underlying Promise.
 */
export class Singleflight<K = string> {
  private readonly inflight = new Map<K, Promise<unknown>>();

  /** Number of currently running deduplicated operations. */
  get size(): number {
    return this.inflight.size;
  }

  /** Checks whether an operation for `key` is currently in flight. */
  has(key: K): boolean {
    return this.inflight.has(key);
  }

  /**
   * Executes `fn` for `key` or shares the existing in-flight Promise if one is already running.
   */
  run<T>(key: K, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (isNotUndefined(existing)) {
      return existing as Promise<T>;
    }
    const promise = Promise.resolve()
      .then(fn)
      .finally(() => {
        if (this.inflight.get(key) === promise) {
          this.inflight.delete(key);
        }
      });
    this.inflight.set(key, promise);
    return promise;
  }
}

/**
 * Wraps an async keyed loader with a dedicated `Singleflight` deduplicator.
 */
export function coalesceAsync<K, V>(
  loader: (key: K) => Promise<V>,
): (key: K) => Promise<V> {
  const sf = new Singleflight<K>();
  return (key: K): Promise<V> => sf.run(key, () => loader(key));
}

export interface BatchLoaderOptions {
  /** Maximum keys per batch dispatch (default `Infinity`). */
  readonly maxBatchSize?: number;
}

interface BatchRequest<K, V> {
  readonly key: K;
  readonly resolve: (value: V) => void;
  readonly reject: (reason: unknown) => void;
}

/**
 * Lightweight microtask request batcher (DataLoader pattern) that coalesces
 * individual `.load(key)` calls made within the same tick into a single `batchFn(keys)` call.
 */
export class BatchLoader<K, V> {
  private readonly batchFn: (keys: readonly K[]) => Promise<readonly V[]>;
  private readonly maxBatchSize: number;
  private pending: Array<BatchRequest<K, V>> = [];
  private scheduled = false;

  constructor(
    batchFn: (keys: readonly K[]) => Promise<readonly V[]>,
    options: BatchLoaderOptions = {},
  ) {
    if (
      isNotUndefined(options.maxBatchSize) &&
      (not(isInteger(options.maxBatchSize)) || options.maxBatchSize < 1)
    ) {
      throw new RangeError(
        `BatchLoader: maxBatchSize must be a positive integer (got ${options.maxBatchSize})`,
      );
    }
    this.batchFn = batchFn;
    this.maxBatchSize = options.maxBatchSize ?? Number.POSITIVE_INFINITY;
  }

  /** Enqueues a single key to be resolved in the next microtask batch. */
  load(key: K): Promise<V> {
    const req = deferred<V>();
    this.pending.push({ key, resolve: req.resolve, reject: req.reject });
    if (this.pending.length >= this.maxBatchSize) {
      this.flush();
    } else if (not(this.scheduled)) {
      this.scheduled = true;
      queueMicrotask(() => {
        this.scheduled = false;
        this.flush();
      });
    }
    return req.promise;
  }

  /** Loads multiple keys concurrently in the same batch tick. */
  loadMany(keys: readonly K[]): Promise<V[]> {
    return Promise.all(keys.map((k) => this.load(k)));
  }

  private flush(): void {
    while (this.pending.length > 0) {
      const sliceSize = Number.isFinite(this.maxBatchSize)
        ? this.maxBatchSize
        : this.pending.length;
      const batch = this.pending.splice(0, sliceSize);
      const keys = batch.map((item) => item.key);
      void Promise.resolve()
        .then(() => this.batchFn(keys))
        .then(
          (values) => {
            if (values.length !== batch.length) {
              const err = new Error(
                `BatchLoader: batchFn returned ${values.length} results for ${batch.length} keys.`,
              );
              for (const item of batch) {
                item.reject(err);
              }
              return;
            }
            for (let i = 0; i < batch.length; i++) {
              batch[i]!.resolve(values[i] as V);
            }
          },
          (error: unknown) => {
            for (const item of batch) {
              item.reject(error);
            }
          },
        );
    }
  }
}
