import { type Comparator, compareAsc } from "./compare.util";
import { type Duration, parseDuration } from "./duration.util";
import { not } from "./predicate.util";
import { isInteger, isNotUndefined, isUndefined } from "./type-guards.util";

// ─── LruCache<K, V> ──────────────────────────────────────────────────────────

export interface LruCacheOptions {
  /** Maximum number of entries to retain (must be >= 1). */
  readonly maxSize: number;
  /** Optional default TTL applied to entries when no per-entry TTL is specified. */
  readonly ttl?: Duration;
  /** Optional clock provider for deterministic TTL testing (default `Date.now`). */
  readonly now?: () => number;
}

interface CacheEntry<V> {
  readonly value: V;
  readonly expiresAt?: number;
}

/**
 * O(1) Least-Recently-Used cache with optional TTL expiration.
 */
export class LruCache<K, V> {
  private readonly maxSize: number;
  private readonly defaultTtlMs?: number;
  private readonly now: () => number;
  private readonly store = new Map<K, CacheEntry<V>>();

  constructor(options: LruCacheOptions) {
    if (not(isInteger(options.maxSize)) || options.maxSize < 1) {
      throw new RangeError(
        `LruCache: maxSize must be a positive integer (got ${options.maxSize})`,
      );
    }
    this.maxSize = options.maxSize;
    this.defaultTtlMs = isNotUndefined(options.ttl)
      ? parseDuration(options.ttl)
      : undefined;
    this.now = options.now ?? Date.now;
  }

  private isExpiredEntry(entry: CacheEntry<V>): boolean {
    return isNotUndefined(entry.expiresAt) && this.now() >= entry.expiresAt;
  }

  /** Number of entries currently stored (excluding expired entries pruned on access). */
  get size(): number {
    this.prune();
    return this.store.size;
  }

  /** Gets a value and refreshes its recency, or returns `undefined` if missing/expired. */
  get(key: K): V | undefined {
    const entry = this.store.get(key);
    if (isUndefined(entry)) {
      return undefined;
    }
    if (this.isExpiredEntry(entry)) {
      this.store.delete(key);
      return undefined;
    }
    // Move to most-recently-used tail
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  /** Reads a value without refreshing its recency. */
  peek(key: K): V | undefined {
    const entry = this.store.get(key);
    if (isUndefined(entry)) {
      return undefined;
    }
    if (this.isExpiredEntry(entry)) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /** Checks whether a non-expired entry exists for `key` (without refreshing recency). */
  has(key: K): boolean {
    return isNotUndefined(this.peek(key));
  }

  /** Inserts or updates `key` with optional per-entry `ttl`, evicting the LRU entry if full. */
  set(key: K, value: V, ttl?: Duration): this {
    const ttlMs = isNotUndefined(ttl) ? parseDuration(ttl) : this.defaultTtlMs;
    const expiresAt = isNotUndefined(ttlMs) ? this.now() + ttlMs : undefined;

    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.maxSize) {
      this.prune();
      if (this.store.size >= this.maxSize) {
        const oldestKey = this.store.keys().next().value;
        if (isNotUndefined(oldestKey) || this.store.has(oldestKey as K)) {
          this.store.delete(oldestKey as K);
        }
      }
    }

    this.store.set(key, { value, expiresAt });
    return this;
  }

  /** Removes a key from the cache. */
  delete(key: K): boolean {
    return this.store.delete(key);
  }

  /** Removes all entries from the cache. */
  clear(): void {
    this.store.clear();
  }

  /** Removes all expired entries and returns the count removed. */
  prune(): number {
    let removed = 0;
    for (const [k, entry] of this.store.entries()) {
      if (this.isExpiredEntry(entry)) {
        this.store.delete(k);
        removed += 1;
      }
    }
    return removed;
  }

  /** Returns live keys ordered from least-recently-used to most-recently-used. */
  keys(): K[] {
    this.prune();
    return [...this.store.keys()];
  }
}

// ─── RingBuffer<T> ───────────────────────────────────────────────────────────

/**
 * Fixed-capacity circular buffer (FIFO) that overwrites the oldest element when full.
 */
export class RingBuffer<T> {
  public readonly capacity: number;
  private readonly buffer: Array<T | undefined>;
  private head = 0;
  private count = 0;

  constructor(capacity: number) {
    if (not(isInteger(capacity)) || capacity < 1) {
      throw new RangeError(
        `RingBuffer: capacity must be a positive integer (got ${capacity})`,
      );
    }
    this.capacity = capacity;
    this.buffer = new Array<T | undefined>(capacity);
  }

  get size(): number {
    return this.count;
  }

  get isEmpty(): boolean {
    return this.count === 0;
  }

  get isFull(): boolean {
    return this.count === this.capacity;
  }

  /** Appends `item`, returning any overwritten oldest item if the buffer was full. */
  push(item: T): T | undefined {
    const tail = (this.head + this.count) % this.capacity;
    if (this.count === this.capacity) {
      const evicted = this.buffer[this.head];
      this.buffer[this.head] = item;
      this.head = (this.head + 1) % this.capacity;
      return evicted;
    }
    this.buffer[tail] = item;
    this.count += 1;
    return undefined;
  }

  /** Removes and returns the oldest item, or `undefined` if empty. */
  shift(): T | undefined {
    if (this.count === 0) {
      return undefined;
    }
    const item = this.buffer[this.head];
    this.buffer[this.head] = undefined;
    this.head = (this.head + 1) % this.capacity;
    this.count -= 1;
    return item;
  }

  /** Returns the oldest item without removing it. */
  peek(): T | undefined {
    return this.count === 0 ? undefined : this.buffer[this.head];
  }

  /** Returns all items ordered from oldest to newest. */
  toArray(): T[] {
    const result: T[] = new Array(this.count);
    for (let i = 0; i < this.count; i++) {
      result[i] = this.buffer[(this.head + i) % this.capacity] as T;
    }
    return result;
  }

  clear(): void {
    this.buffer.fill(undefined);
    this.head = 0;
    this.count = 0;
  }
}

// ─── BiMap<K, V> ─────────────────────────────────────────────────────────────

/**
 * Bidirectional 1-to-1 map supporting O(1) lookup by key (`get`) and by value (`getKey`).
 */
export class BiMap<K, V> {
  private readonly forward = new Map<K, V>();
  private readonly reverse = new Map<V, K>();

  get size(): number {
    return this.forward.size;
  }

  set(key: K, value: V): this {
    if (this.forward.has(key)) {
      const oldVal = this.forward.get(key) as V;
      this.reverse.delete(oldVal);
    }
    if (this.reverse.has(value)) {
      const oldKey = this.reverse.get(value) as K;
      this.forward.delete(oldKey);
    }
    this.forward.set(key, value);
    this.reverse.set(value, key);
    return this;
  }

  get(key: K): V | undefined {
    return this.forward.get(key);
  }

  getKey(value: V): K | undefined {
    return this.reverse.get(value);
  }

  has(key: K): boolean {
    return this.forward.has(key);
  }

  hasValue(value: V): boolean {
    return this.reverse.has(value);
  }

  delete(key: K): boolean {
    if (not(this.forward.has(key))) {
      return false;
    }
    const val = this.forward.get(key) as V;
    this.forward.delete(key);
    this.reverse.delete(val);
    return true;
  }

  deleteValue(value: V): boolean {
    if (not(this.reverse.has(value))) {
      return false;
    }
    const key = this.reverse.get(value) as K;
    this.reverse.delete(value);
    this.forward.delete(key);
    return true;
  }

  clear(): void {
    this.forward.clear();
    this.reverse.clear();
  }

  entries(): IterableIterator<[K, V]> {
    return this.forward.entries();
  }
}

// ─── MultiMap<K, V> ──────────────────────────────────────────────────────────

/**
 * Key-to-many-values map storing a list of values per key.
 */
export class MultiMap<K, V> {
  private readonly store = new Map<K, V[]>();

  /** Number of distinct keys. */
  get keyCount(): number {
    return this.store.size;
  }

  /** Total number of values across all keys. */
  get size(): number {
    let total = 0;
    for (const list of this.store.values()) {
      total += list.length;
    }
    return total;
  }

  add(key: K, value: V): this {
    const existing = this.store.get(key);
    if (isNotUndefined(existing)) {
      existing.push(value);
    } else {
      this.store.set(key, [value]);
    }
    return this;
  }

  get(key: K): readonly V[] {
    return this.store.get(key) ?? [];
  }

  has(key: K): boolean {
    return this.store.has(key);
  }

  deleteKey(key: K): boolean {
    return this.store.delete(key);
  }

  deleteValue(key: K, value: V): boolean {
    const list = this.store.get(key);
    if (isUndefined(list)) {
      return false;
    }
    const idx = list.indexOf(value);
    if (idx === -1) {
      return false;
    }
    list.splice(idx, 1);
    if (list.length === 0) {
      this.store.delete(key);
    }
    return true;
  }

  clear(): void {
    this.store.clear();
  }

  entries(): IterableIterator<[K, V[]]> {
    return this.store.entries();
  }
}

// ─── PriorityQueue<T> ────────────────────────────────────────────────────────

/**
 * Binary min-heap priority queue (defaults to `compareAsc`; pass `compareDesc` for max-heap).
 */
export class PriorityQueue<T> {
  private readonly heap: T[] = [];
  private readonly compare: Comparator<T>;

  constructor(comparator: Comparator<T> = compareAsc) {
    this.compare = comparator;
  }

  get size(): number {
    return this.heap.length;
  }

  get isEmpty(): boolean {
    return this.heap.length === 0;
  }

  peek(): T | undefined {
    return this.heap[0];
  }

  push(item: T): this {
    this.heap.push(item);
    this.siftUp(this.heap.length - 1);
    return this;
  }

  pop(): T | undefined {
    if (this.heap.length === 0) {
      return undefined;
    }
    const top = this.heap[0];
    const last = this.heap.pop() as T;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  clear(): void {
    this.heap.length = 0;
  }

  private siftUp(index: number): void {
    let idx = index;
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      if (this.compare(this.heap[idx] as T, this.heap[parent] as T) < 0) {
        const tmp = this.heap[parent] as T;
        this.heap[parent] = this.heap[idx] as T;
        this.heap[idx] = tmp;
        idx = parent;
      } else {
        break;
      }
    }
  }

  private siftDown(index: number): void {
    let idx = index;
    const len = this.heap.length;
    while (true) {
      const left = idx * 2 + 1;
      const right = left + 1;
      let smallest = idx;
      if (
        left < len &&
        this.compare(this.heap[left] as T, this.heap[smallest] as T) < 0
      ) {
        smallest = left;
      }
      if (
        right < len &&
        this.compare(this.heap[right] as T, this.heap[smallest] as T) < 0
      ) {
        smallest = right;
      }
      if (smallest === idx) {
        break;
      }
      const tmp = this.heap[smallest] as T;
      this.heap[smallest] = this.heap[idx] as T;
      this.heap[idx] = tmp;
      idx = smallest;
    }
  }
}
