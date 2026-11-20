import {
  Injectable,
  Logger,
  type OnApplicationShutdown,
} from "@bunest/common";
import type {
  Subscribable,
  SubscribableObserver,
  Unsubscribable,
} from "@bunest/core";
import type { OutboxEvent } from "./outbox-events.interface";
import { channels } from "./outbox.channels";

interface SubscriberEntry<T> {
  next?: (value: T) => void;
  complete?: () => void;
}

interface AsyncQueueState<T> {
  readonly buffer: T[];
  readonly waiters: Array<(result: IteratorResult<T>) => void>;
  closed: boolean;
}

/**
 * Internal zero-RxJS push stream (ADR-008) exposing both `Subscribable<T>`
 * (`.subscribe(...)`) and `AsyncIterable<T>` (`for await (...)`).
 */
class OutboxEventSubject<T> {
  private readonly subscribers = new Set<SubscriberEntry<T>>();
  private readonly iterators = new Set<AsyncQueueState<T>>();
  private completed = false;

  constructor(private readonly logger: Logger) {}

  next(value: T): void {
    if (this.completed) {
      return;
    }
    for (const entry of [...this.subscribers]) {
      try {
        entry.next?.(value);
      } catch (error) {
        this.logger.error(
          "Outbox event subscriber threw",
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
    for (const state of [...this.iterators]) {
      if (state.closed) {
        continue;
      }
      const waiter = state.waiters.shift();
      if (waiter) {
        waiter({ value, done: false });
      } else {
        state.buffer.push(value);
      }
    }
  }

  complete(): void {
    if (this.completed) {
      return;
    }
    this.completed = true;
    const active = [...this.subscribers];
    this.subscribers.clear();
    for (const entry of active) {
      try {
        entry.complete?.();
      } catch (error) {
        this.logger.error(
          "Outbox event subscriber completion handler threw",
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
    const openIterators = [...this.iterators];
    this.iterators.clear();
    for (const state of openIterators) {
      state.closed = true;
      while (state.waiters.length > 0) {
        state.waiters.shift()!({
          value: undefined as unknown as T,
          done: true,
        });
      }
    }
  }

  asSubscribable(): Subscribable<T> & AsyncIterable<T> {
    return {
      subscribe: (
        observerOrNext?: SubscribableObserver<T> | ((value: T) => void),
        _error?: (err: unknown) => void,
        complete?: () => void,
      ): Unsubscribable => {
        const nextFn =
          typeof observerOrNext === "function"
            ? observerOrNext
            : observerOrNext?.next?.bind(observerOrNext);
        const completeFn =
          typeof observerOrNext === "function"
            ? complete
            : (observerOrNext?.complete?.bind(observerOrNext) ?? complete);

        if (this.completed) {
          try {
            completeFn?.();
          } catch (error) {
            this.logger.error(
              "Outbox event subscriber completion handler threw",
              error instanceof Error ? error.stack : String(error),
            );
          }
          return { unsubscribe() {} };
        }

        const entry: SubscriberEntry<T> = {
          next: nextFn,
          complete: completeFn,
        };
        this.subscribers.add(entry);

        let active = true;
        return {
          unsubscribe: () => {
            if (!active) {
              return;
            }
            active = false;
            this.subscribers.delete(entry);
          },
        };
      },
      [Symbol.asyncIterator]: (): AsyncIterableIterator<T> => {
        const state: AsyncQueueState<T> = {
          buffer: [],
          waiters: [],
          closed: this.completed,
        };

        if (!this.completed) {
          this.iterators.add(state);
        }

        const closeState = () => {
          if (state.closed) {
            return;
          }
          state.closed = true;
          this.iterators.delete(state);
          while (state.waiters.length > 0) {
            state.waiters.shift()!({
              value: undefined as unknown as T,
              done: true,
            });
          }
        };

        const iterator: AsyncIterableIterator<T> = {
          [Symbol.asyncIterator]() {
            return iterator;
          },
          next(): Promise<IteratorResult<T>> {
            if (state.buffer.length > 0) {
              return Promise.resolve({
                value: state.buffer.shift()!,
                done: false,
              });
            }
            if (state.closed) {
              return Promise.resolve({
                value: undefined as unknown as T,
                done: true,
              });
            }
            return new Promise<IteratorResult<T>>((resolve) => {
              state.waiters.push(resolve);
            });
          },
          return(): Promise<IteratorResult<T>> {
            closeState();
            return Promise.resolve({
              value: undefined as unknown as T,
              done: true,
            });
          },
          throw(err?: unknown): Promise<IteratorResult<T>> {
            closeState();
            return Promise.reject(err);
          },
        };

        return iterator;
      },
    };
  }
}

/**
 * The relay's events in this application, for metrics and alerting. Every event is also
 * published on its `node:diagnostics_channel` channel (`nestjs:outbox:<type>`), where
 * instrumentation can subscribe without depending on Bunest.
 *
 * Exposes zero-RxJS `Subscribable<OutboxEvent> & AsyncIterable<OutboxEvent>` per ADR-008.
 */
@Injectable()
export class OutboxEvents implements OnApplicationShutdown {
  private readonly logger = new Logger("OutboxEvents");
  private closed = false;
  private readonly subject = new OutboxEventSubject<OutboxEvent>(this.logger);
  readonly events$: Subscribable<OutboxEvent> & AsyncIterable<OutboxEvent> =
    this.subject.asSubscribable();

  emit(event: OutboxEvent): void {
    if (this.closed) {
      return;
    }
    const target = channels[event.type];
    if (target.hasSubscribers) {
      target.publish(event);
    }
    this.subject.next(event);
  }

  // After onModuleDestroy, where the relay drains and may still emit.
  onApplicationShutdown(): void {
    this.closed = true;
    this.subject.complete();
  }
}
