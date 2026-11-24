import { Injectable, type OnApplicationShutdown } from "@bunest/core";
import type {
  Subscribable,
  SubscribableObserver,
  Unsubscribable,
} from "@bunest/core";
import { channels } from "./idempotency.channels";
import type { IdempotencyEvent } from "./idempotency-events.interface";

/**
 * Zero-RxJS multicast event stream supporting both `.subscribe(...)` and
 * `for await (const event of events.events$)` (ADR-008).
 */
export interface IdempotencyEventStream
  extends Subscribable<IdempotencyEvent>, AsyncIterable<IdempotencyEvent> {}

interface SubscriberEntry {
  next?: (value: IdempotencyEvent) => void;
  complete?: () => void;
}

/**
 * The app's idempotency events, for metrics and alerts. Each event is also
 * published on `node:diagnostics_channel`, as `nestjs:idempotency:replayed`,
 * `nestjs:idempotency:rejected` and `nestjs:idempotency:lock-lost`, for
 * tracing and APM tools.
 */
@Injectable()
export class IdempotencyEvents implements OnApplicationShutdown {
  private readonly subscribers = new Set<SubscriberEntry>();
  private completed = false;
  readonly events$: IdempotencyEventStream;

  constructor() {
    this.events$ = {
      subscribe: (
        observerOrNext?:
          | SubscribableObserver<IdempotencyEvent>
          | ((value: IdempotencyEvent) => void),
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
          completeFn?.();
          return { unsubscribe() {} };
        }

        const entry: SubscriberEntry = {
          next: nextFn,
          complete: completeFn,
        };
        this.subscribers.add(entry);

        let active = true;
        return {
          unsubscribe: () => {
            if (!active) return;
            active = false;
            this.subscribers.delete(entry);
          },
        };
      },

      [Symbol.asyncIterator]: (): AsyncIterator<IdempotencyEvent, undefined> => {
        if (this.completed) {
          return {
            next: () =>
              Promise.resolve({
                value: undefined,
                done: true,
              }),
            return: () =>
              Promise.resolve({
                value: undefined,
                done: true,
              }),
          };
        }

        const queue: IdempotencyEvent[] = [];
        const waiters: Array<
          (result: IteratorResult<IdempotencyEvent, undefined>) => void
        > = [];
        let closed = false;

        const sub = this.events$.subscribe({
          next: (event) => {
            if (closed) return;
            const waiter = waiters.shift();
            if (waiter) {
              waiter({ value: event, done: false });
            } else {
              queue.push(event);
            }
          },
          complete: () => {
            closed = true;
            while (waiters.length > 0) {
              const waiter = waiters.shift()!;
              waiter({
                value: undefined,
                done: true,
              });
            }
          },
        });

        return {
          next: () => {
            if (queue.length > 0) {
              return Promise.resolve({ value: queue.shift()!, done: false });
            }
            if (closed) {
              return Promise.resolve({
                value: undefined,
                done: true,
              });
            }
            return new Promise<IteratorResult<IdempotencyEvent, undefined>>(
              (resolve) => {
                waiters.push(resolve);
              },
            );
          },
          return: () => {
            closed = true;
            sub.unsubscribe();
            queue.length = 0;
            while (waiters.length > 0) {
              const waiter = waiters.shift()!;
              waiter({
                value: undefined,
                done: true,
              });
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

  /** Called by the interceptor. */
  emit(event: IdempotencyEvent): void {
    const diagnostics = channels[event.type];
    if (diagnostics.hasSubscribers) {
      diagnostics.publish(event);
    }
    if (this.completed) {
      return;
    }
    for (const sub of [...this.subscribers]) {
      sub.next?.(event);
    }
  }

  onApplicationShutdown(): void {
    if (this.completed) {
      return;
    }
    this.completed = true;
    const current = [...this.subscribers];
    this.subscribers.clear();
    for (const sub of current) {
      sub.complete?.();
    }
  }
}
