import { Injectable, type OnApplicationShutdown } from "@bunest/core";
import type {
  Subscribable,
  SubscribableObserver,
  Unsubscribable,
} from "@bunest/core";
import { isFunction } from "@bunest/core/common";
import type { WorkflowEvent } from "./workflow-events.interface";
import { channelFor } from "./workflows.channels";

interface AsyncQueueState<T> {
  readonly buffer: T[];
  readonly waiters: Array<(result: IteratorResult<T>) => void>;
  closed: boolean;
}

class ZeroRxEventStream<T> implements Subscribable<T>, AsyncIterable<T> {
  private readonly subscribers = new Set<SubscribableObserver<T>>();
  private readonly iterators = new Set<AsyncQueueState<T>>();
  private completed = false;

  next(value: T): void {
    if (this.completed) return;
    for (const observer of [...this.subscribers]) {
      try {
        observer.next?.(value);
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

  complete(): void {
    if (this.completed) return;
    this.completed = true;
    for (const observer of [...this.subscribers]) {
      try {
        observer.complete?.();
      } catch {
        // Ignore completion errors
      }
    }
    this.subscribers.clear();
    for (const state of [...this.iterators]) {
      state.closed = true;
      while (state.waiters.length > 0) {
        state.waiters.shift()!({ value: undefined as T, done: true });
      }
    }
    this.iterators.clear();
  }

  subscribe(
    observerOrNext?: SubscribableObserver<T> | ((value: T) => void) | null,
    error?: ((err: unknown) => void) | null,
    complete?: (() => void) | null,
  ): Unsubscribable {
    let observer: SubscribableObserver<T> = {};
    if (isFunction(observerOrNext)) {
      observer = {
        next: observerOrNext,
        error: error ?? undefined,
        complete: complete ?? undefined,
      };
    } else if (observerOrNext) {
      observer = {
        next: observerOrNext.next?.bind(observerOrNext),
        error: observerOrNext.error?.bind(observerOrNext),
        complete: observerOrNext.complete?.bind(observerOrNext),
      };
    }

    if (this.completed) {
      observer.complete?.();
      return { unsubscribe() {} };
    }

    this.subscribers.add(observer);
    let active = true;
    return {
      unsubscribe: () => {
        if (!active) return;
        active = false;
        this.subscribers.delete(observer);
      },
    };
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
          return Promise.resolve({
            value: state.buffer.shift()!,
            done: false,
          });
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
}

/**
 * This application's lifecycle events, for logs, metrics and alerts. Every event
 * is also published on its `node:diagnostics_channel` channel
 * (`nestjs:workflows:<type>`), process-wide, where tracing tools (Observe,
 * OpenTelemetry) subscribe without DI.
 */
@Injectable()
export class WorkflowEvents implements OnApplicationShutdown {
  private readonly subject = new ZeroRxEventStream<WorkflowEvent>();

  readonly events$: Subscribable<WorkflowEvent> & AsyncIterable<WorkflowEvent> =
    {
      subscribe: (observerOrNext, error, complete) =>
        this.subject.subscribe(observerOrNext, error, complete),
      [Symbol.asyncIterator]: () => this.subject[Symbol.asyncIterator](),
    };

  emit(event: WorkflowEvent): void {
    const target = channelFor(event.type);
    if (target.hasSubscribers) {
      target.publish(event);
    }
    this.subject.next(event);
  }

  onApplicationShutdown(): void {
    this.subject.complete();
  }
}
