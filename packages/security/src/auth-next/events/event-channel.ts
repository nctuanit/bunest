import type {
  Subscribable,
  SubscribableObserver,
  Unsubscribable,
} from "@bunest/core";

export interface EventStream<T> extends Subscribable<T>, AsyncIterable<T> {}

interface AsyncQueue<T> {
  buffer: T[];
  resolvers: Array<(result: IteratorResult<T, undefined>) => void>;
  closed: boolean;
}

/**
 * Zero-RxJS multicast event channel supporting both `.subscribe(...)` and
 * `for await (const event of stream)` (ADR-008).
 */
export class EventChannel<T> {
  private readonly listeners = new Set<SubscribableObserver<T>>();
  private readonly queues = new Set<AsyncQueue<T>>();
  private completed = false;

  next(value: T): void {
    if (this.completed) {
      return;
    }
    for (const observer of [...this.listeners]) {
      observer.next?.(value);
    }
    for (const queue of [...this.queues]) {
      if (queue.closed) continue;
      const resolve = queue.resolvers.shift();
      if (resolve) {
        resolve({ value, done: false });
      } else {
        queue.buffer.push(value);
      }
    }
  }

  complete(): void {
    if (this.completed) {
      return;
    }
    this.completed = true;
    const listeners = [...this.listeners];
    this.listeners.clear();
    for (const observer of listeners) {
      observer.complete?.();
    }
    const queues = [...this.queues];
    this.queues.clear();
    for (const queue of queues) {
      queue.closed = true;
      while (queue.resolvers.length > 0) {
        const resolve = queue.resolvers.shift();
        resolve?.({ value: undefined, done: true });
      }
    }
  }

  asStream(): EventStream<T> {
    return {
      subscribe: (
        observerOrNext?: SubscribableObserver<T> | ((value: T) => void),
        error?: (err: unknown) => void,
        complete?: () => void,
      ): Unsubscribable => {
        const observer: SubscribableObserver<T> =
          typeof observerOrNext === "function"
            ? { next: observerOrNext, error, complete }
            : {
                next: observerOrNext?.next?.bind(observerOrNext),
                error: observerOrNext?.error?.bind(observerOrNext) ?? error,
                complete:
                  observerOrNext?.complete?.bind(observerOrNext) ?? complete,
              };

        if (this.completed) {
          observer.complete?.();
          return { unsubscribe() {} };
        }

        this.listeners.add(observer);
        return {
          unsubscribe: () => {
            this.listeners.delete(observer);
          },
        };
      },
      [Symbol.asyncIterator]: (): AsyncIterator<T, undefined> => {
        const queue: AsyncQueue<T> = {
          buffer: [],
          resolvers: [],
          closed: this.completed,
        };
        if (!this.completed) {
          this.queues.add(queue);
        }
        return {
          next: (): Promise<IteratorResult<T, undefined>> => {
            if (queue.buffer.length > 0) {
              const value = queue.buffer.shift()!;
              return Promise.resolve({ value, done: false });
            }
            if (queue.closed) {
              return Promise.resolve({
                value: undefined,
                done: true,
              });
            }
            return new Promise<IteratorResult<T, undefined>>((resolve) => {
              queue.resolvers.push(resolve);
            });
          },
          return: (): Promise<IteratorResult<T, undefined>> => {
            queue.closed = true;
            this.queues.delete(queue);
            while (queue.resolvers.length > 0) {
              const resolve = queue.resolvers.shift();
              resolve?.({ value: undefined, done: true });
            }
            return Promise.resolve({
              value: undefined,
              done: true,
            });
          },
        };
      },
    };
  }
}
