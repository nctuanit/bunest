export interface ObserverLike<T> {
  next?: (value: T) => void | Promise<void>;
  error?: (err: unknown) => void;
  complete?: () => void;
}

export type StreamListener<T> =
  | ((value: T) => void | Promise<void>)
  | Partial<ObserverLike<T>>;

/**
 * Subscription handle usable both as a cleanup callback `unsub()` and as a
 * standard `{ unsubscribe() }` object (zero RxJS).
 */
export type SubscriptionHandle = (() => void) & {
  unsubscribe(): void;
};

export interface Subscribable<T> {
  subscribe(listenerOrObserver: StreamListener<T>): SubscriptionHandle;
  [Symbol.asyncIterator](): AsyncIterableIterator<T>;
}

export interface SubjectLike<T> extends Subscribable<T> {
  next(value: T): void;
}

interface AsyncQueueState<T> {
  readonly buffer: T[];
  readonly waiters: Array<(result: IteratorResult<T>) => void>;
  closed: boolean;
}

function createSubscriptionHandle(cleanup: () => void): SubscriptionHandle {
  let active = true;
  const unsub = (() => {
    if (!active) return;
    active = false;
    cleanup();
  }) as SubscriptionHandle;
  unsub.unsubscribe = unsub;
  return unsub;
}

/**
 * Lightweight, zero-RxJS push stream supporting both `{ subscribe(...) }`
 * callbacks/observers and native `for await (const item of stream)` iteration.
 */
export class SubscribableStream<T> implements SubjectLike<T> {
  private readonly subscribers = new Set<(value: T) => void | Promise<void>>();
  private readonly completeCallbacks = new Set<() => void>();
  private readonly iterators = new Set<AsyncQueueState<T>>();
  private completed = false;

  next(value: T): void {
    if (this.completed) {
      return;
    }
    for (const subscriber of [...this.subscribers]) {
      try {
        void subscriber(value);
      } catch {
        // Isolate synchronous subscriber errors
      }
    }
    for (const state of [...this.iterators]) {
      if (state.closed) continue;
      const waiter = state.waiters.shift();
      if (waiter) {
        waiter({ value, done: false });
      } else {
        state.buffer.push(value);
      }
    }
  }

  /**
   * Emits `value` and awaits all async/sync subscribers (used internally by buses
   * that need deterministic Promise settlement).
   */
  async nextAsync(
    value: T,
    skipSubscriber?: (value: T) => void | Promise<void>,
  ): Promise<void> {
    if (this.completed) {
      return;
    }
    const tasks: Array<Promise<void>> = [];
    for (const subscriber of [...this.subscribers]) {
      if (skipSubscriber && subscriber === skipSubscriber) {
        continue;
      }
      tasks.push(
        Promise.resolve()
          .then(() => subscriber(value))
          .then(() => undefined),
      );
    }
    for (const state of [...this.iterators]) {
      if (state.closed) continue;
      const waiter = state.waiters.shift();
      if (waiter) {
        waiter({ value, done: false });
      } else {
        state.buffer.push(value);
      }
    }
    if (tasks.length > 0) {
      await Promise.all(tasks);
    }
  }

  subscribe(listenerOrObserver: StreamListener<T>): SubscriptionHandle {
    const fn =
      typeof listenerOrObserver === "function"
        ? listenerOrObserver
        : listenerOrObserver.next
          ? (v: T) => listenerOrObserver.next!(v)
          : () => undefined;

    const onComplete =
      typeof listenerOrObserver === "object" && listenerOrObserver !== null
        ? listenerOrObserver.complete
        : undefined;

    if (this.completed) {
      onComplete?.();
      return createSubscriptionHandle(() => undefined);
    }

    this.subscribers.add(fn);
    if (onComplete) {
      this.completeCallbacks.add(onComplete);
    }

    return createSubscriptionHandle(() => {
      this.subscribers.delete(fn);
      if (onComplete) {
        this.completeCallbacks.delete(onComplete);
      }
    });
  }

  filter<U extends T>(predicate: (value: T) => value is U): SubscribableStream<U>;
  filter(predicate: (value: T) => boolean): SubscribableStream<T>;
  filter(predicate: (value: T) => boolean): SubscribableStream<any> {
    const derived = new SubscribableStream<any>();
    const unsub = this.subscribe({
      next: (val) => {
        if (predicate(val)) {
          derived.next(val);
        }
      },
      complete: () => {
        derived.complete();
      },
    });
    const origComplete = derived.complete.bind(derived);
    derived.complete = () => {
      unsub();
      origComplete();
    };
    return derived;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    const state: AsyncQueueState<T> = {
      buffer: [],
      waiters: [],
      closed: this.completed,
    };

    if (!this.completed) {
      this.iterators.add(state);
    }

    const closeState = () => {
      if (state.closed) return;
      state.closed = true;
      this.iterators.delete(state);
      while (state.waiters.length > 0) {
        state.waiters.shift()!({ value: undefined as T, done: true });
      }
    };

    const iterator: AsyncIterableIterator<T> = {
      [Symbol.asyncIterator]() {
        return iterator;
      },
      next(): Promise<IteratorResult<T>> {
        if (state.buffer.length > 0) {
          return Promise.resolve({ value: state.buffer.shift()!, done: false });
        }
        if (state.closed) {
          return Promise.resolve({ value: undefined as T, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          state.waiters.push(resolve);
        });
      },
      return(): Promise<IteratorResult<T>> {
        closeState();
        return Promise.resolve({ value: undefined as T, done: true });
      },
      throw(err?: unknown): Promise<IteratorResult<T>> {
        closeState();
        return Promise.reject(err);
      },
    };

    return iterator;
  }

  complete(): void {
    if (this.completed) {
      return;
    }
    this.completed = true;
    for (const cb of [...this.completeCallbacks]) {
      try {
        cb();
      } catch {
        // Ignore completion callback errors
      }
    }
    this.subscribers.clear();
    this.completeCallbacks.clear();
    for (const state of [...this.iterators]) {
      state.closed = true;
      while (state.waiters.length > 0) {
        state.waiters.shift()!({ value: undefined as T, done: true });
      }
    }
    this.iterators.clear();
  }

  clear(): void {
    this.subscribers.clear();
    this.completeCallbacks.clear();
    for (const state of [...this.iterators]) {
      state.closed = true;
      while (state.waiters.length > 0) {
        state.waiters.shift()!({ value: undefined as T, done: true });
      }
    }
    this.iterators.clear();
    this.completed = false;
  }
}
