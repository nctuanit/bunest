import type {
  Subscribable,
  SubscribableObserver,
  Unsubscribable,
} from "@bunest/core";

/**
 * Zero-RxJS reactive stream implementing both `Subscribable<T>` and
 * `AsyncIterable<T>` (ADR-008).
 */
export interface ReactiveStream<T> extends Subscribable<T>, AsyncIterable<T> {}

export interface StreamSubscriber<T> {
  next(value: T): void;
  error(err: unknown): void;
  complete(): void;
}

export function isSubscribable<T = unknown>(
  value: unknown,
): value is Subscribable<T> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as Subscribable<T>).subscribe === "function"
  );
}

function normalizeObserver<T>(
  observerOrNext?: SubscribableObserver<T> | ((value: T) => void),
  error?: (err: unknown) => void,
  complete?: () => void,
): {
  next: (value: T) => void;
  error: (err: unknown) => void;
  complete: () => void;
} {
  if (typeof observerOrNext === "function") {
    return {
      next: observerOrNext,
      error: error ?? (() => undefined),
      complete: complete ?? (() => undefined),
    };
  }
  return {
    next: observerOrNext?.next
      ? observerOrNext.next.bind(observerOrNext)
      : () => undefined,
    error: observerOrNext?.error
      ? observerOrNext.error.bind(observerOrNext)
      : (error ?? (() => undefined)),
    complete: observerOrNext?.complete
      ? observerOrNext.complete.bind(observerOrNext)
      : (complete ?? (() => undefined)),
  };
}

/**
 * Cold zero-RxJS `Subscribable<T>` + `AsyncIterable<T>` created from a producer function.
 * Each subscription invokes `producer(subscriber)` lazily; unsubscribing invokes teardown.
 */
export function createColdStream<T>(
  producer: (subscriber: StreamSubscriber<T>) => (() => void) | void,
): ReactiveStream<T> {
  const subscribe = (
    observerOrNext?: SubscribableObserver<T> | ((value: T) => void),
    error?: (err: unknown) => void,
    complete?: () => void,
  ): Unsubscribable => {
    const observer = normalizeObserver(observerOrNext, error, complete);
    let closed = false;
    let teardown: (() => void) | void;

    const cleanup = () => {
      if (teardown) {
        const fn = teardown;
        teardown = undefined;
        try {
          fn();
        } catch {
          // ignore teardown errors
        }
      }
    };

    const subscriber: StreamSubscriber<T> = {
      next(value: T) {
        if (closed) return;
        observer.next(value);
      },
      error(err: unknown) {
        if (closed) return;
        closed = true;
        try {
          observer.error(err);
        } finally {
          cleanup();
        }
      },
      complete() {
        if (closed) return;
        closed = true;
        try {
          observer.complete();
        } finally {
          cleanup();
        }
      },
    };

    try {
      teardown = producer(subscriber);
      if (closed) {
        cleanup();
      }
    } catch (err) {
      subscriber.error(err);
    }

    return {
      unsubscribe() {
        if (closed) return;
        closed = true;
        cleanup();
      },
    };
  };

  const asyncIterator = (): AsyncIterator<T> => {
    const buffer: T[] = [];
    const waiters: Array<{
      resolve: (res: IteratorResult<T>) => void;
      reject: (err: unknown) => void;
    }> = [];
    let done = false;
    let failed = false;
    let failureError: unknown;
    let subscription: Unsubscribable | undefined;
    let started = false;

    const ensureStarted = () => {
      if (started) return;
      started = true;
      subscription = subscribe({
        next(value) {
          const waiter = waiters.shift();
          if (waiter) {
            waiter.resolve({ value, done: false });
          } else {
            buffer.push(value);
          }
        },
        error(err) {
          done = true;
          failed = true;
          failureError = err;
          while (waiters.length > 0) {
            waiters.shift()!.reject(err);
          }
        },
        complete() {
          done = true;
          while (waiters.length > 0) {
            waiters.shift()!.resolve({ value: undefined as never, done: true });
          }
        },
      });
    };

    return {
      next(): Promise<IteratorResult<T>> {
        ensureStarted();
        if (buffer.length > 0) {
          return Promise.resolve({ value: buffer.shift()!, done: false });
        }
        if (failed) {
          const err = failureError;
          failed = false;
          return Promise.reject(err);
        }
        if (done) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise((resolve, reject) => {
          waiters.push({ resolve, reject });
        });
      },
      return(): Promise<IteratorResult<T>> {
        done = true;
        subscription?.unsubscribe();
        while (waiters.length > 0) {
          waiters.shift()!.resolve({ value: undefined as never, done: true });
        }
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  };

  return {
    subscribe,
    [Symbol.asyncIterator]: asyncIterator,
  };
}

/**
 * Hot multicast zero-RxJS Subject implementing `Subscribable<T>` + `AsyncIterable<T>`
 * (ADR-008 replacement for RxJS `Subject`).
 */
export class EventSubject<T> {
  private readonly subscribers = new Set<{
    next: (value: T) => void;
    complete: () => void;
  }>();
  private completed = false;

  next(value: T): void {
    if (this.completed) return;
    for (const sub of [...this.subscribers]) {
      try {
        sub.next(value);
      } catch {
        // A listener error must never break other listeners or the caller.
      }
    }
  }

  complete(): void {
    if (this.completed) return;
    this.completed = true;
    const subs = [...this.subscribers];
    this.subscribers.clear();
    for (const sub of subs) {
      try {
        sub.complete();
      } catch {
        // ignore listener errors on shutdown
      }
    }
  }

  asStream(): ReactiveStream<T> {
    const subscribe = (
      observerOrNext?: SubscribableObserver<T> | ((value: T) => void),
      error?: (err: unknown) => void,
      complete?: () => void,
    ): Unsubscribable => {
      const observer = normalizeObserver(observerOrNext, error, complete);
      if (this.completed) {
        observer.complete();
        return { unsubscribe() {} };
      }
      const entry = {
        next: observer.next,
        complete: observer.complete,
      };
      this.subscribers.add(entry);
      return {
        unsubscribe: () => {
          this.subscribers.delete(entry);
        },
      };
    };

    const asyncIterator = (): AsyncIterator<T> => {
      if (this.completed) {
        return {
          next: () =>
            Promise.resolve({ value: undefined as never, done: true }),
          return: () =>
            Promise.resolve({ value: undefined as never, done: true }),
        };
      }
      const buffer: T[] = [];
      const waiters: Array<(res: IteratorResult<T>) => void> = [];
      let done = false;
      const sub = subscribe({
        next(value) {
          const waiter = waiters.shift();
          if (waiter) {
            waiter({ value, done: false });
          } else {
            buffer.push(value);
          }
        },
        complete() {
          done = true;
          while (waiters.length > 0) {
            waiters.shift()!({ value: undefined as never, done: true });
          }
        },
      });

      return {
        next(): Promise<IteratorResult<T>> {
          if (buffer.length > 0) {
            return Promise.resolve({ value: buffer.shift()!, done: false });
          }
          if (done) {
            return Promise.resolve({ value: undefined as never, done: true });
          }
          return new Promise((resolve) => {
            waiters.push(resolve);
          });
        },
        return(): Promise<IteratorResult<T>> {
          done = true;
          sub.unsubscribe();
          while (waiters.length > 0) {
            waiters.shift()!({ value: undefined as never, done: true });
          }
          return Promise.resolve({ value: undefined as never, done: true });
        },
      };
    };

    return {
      subscribe,
      [Symbol.asyncIterator]: asyncIterator,
    };
  }
}
