import { Injectable } from "@bunest/common";
import type {
  Subscribable,
  SubscribableObserver,
  Unsubscribable,
} from "@bunest/core";
import { channels } from "./mail.channels";
import type { MailEvent } from "./mail-events.interface";

export type MailEventStream = Subscribable<MailEvent> &
  AsyncIterable<MailEvent>;

interface ActiveObserver {
  active: boolean;
  next?: (value: MailEvent) => void;
  complete?: () => void;
}

class MailEventSubject {
  private readonly observers = new Set<ActiveObserver>();
  private completed = false;

  next(value: MailEvent): void {
    if (this.completed) {
      return;
    }
    for (const observer of [...this.observers]) {
      if (observer.active) {
        observer.next?.(value);
      }
    }
  }

  complete(): void {
    if (this.completed) {
      return;
    }
    this.completed = true;
    const current = [...this.observers];
    this.observers.clear();
    for (const observer of current) {
      if (observer.active) {
        observer.active = false;
        observer.complete?.();
      }
    }
  }

  subscribe(
    observerOrNext?:
      | SubscribableObserver<MailEvent>
      | ((value: MailEvent) => void),
    _error?: (err: unknown) => void,
    complete?: () => void,
  ): Unsubscribable {
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

    const entry: ActiveObserver = {
      active: true,
      next: nextFn,
      complete: completeFn,
    };
    this.observers.add(entry);

    return {
      unsubscribe: () => {
        if (!entry.active) {
          return;
        }
        entry.active = false;
        this.observers.delete(entry);
      },
    };
  }

  asStream(): MailEventStream {
    return {
      subscribe: (
        observerOrNext?:
          | SubscribableObserver<MailEvent>
          | ((value: MailEvent) => void),
        error?: (err: unknown) => void,
        complete?: () => void,
      ): Unsubscribable => this.subscribe(observerOrNext, error, complete),
      [Symbol.asyncIterator]: (): AsyncIterableIterator<MailEvent> => {
        const buffer: MailEvent[] = [];
        const waiters: Array<(result: IteratorResult<MailEvent>) => void> = [];
        let done = false;

        const sub = this.subscribe({
          next: (event) => {
            if (done) {
              return;
            }
            const waiter = waiters.shift();
            if (waiter) {
              waiter({ value: event, done: false });
            } else {
              buffer.push(event);
            }
          },
          complete: () => {
            done = true;
            while (waiters.length) {
              waiters.shift()!({ value: undefined, done: true });
            }
          },
        });

        const iterator: AsyncIterableIterator<MailEvent> = {
          [Symbol.asyncIterator]() {
            return this;
          },
          next(): Promise<IteratorResult<MailEvent>> {
            if (buffer.length > 0) {
              return Promise.resolve({ value: buffer.shift()!, done: false });
            }
            if (done) {
              return Promise.resolve({ value: undefined, done: true });
            }
            return new Promise<IteratorResult<MailEvent>>((resolve) => {
              waiters.push(resolve);
            });
          },
          return(): Promise<IteratorResult<MailEvent>> {
            done = true;
            sub.unsubscribe();
            buffer.length = 0;
            while (waiters.length) {
              waiters.shift()!({ value: undefined, done: true });
            }
            return Promise.resolve({ value: undefined, done: true });
          },
        };
        return iterator;
      },
    };
  }
}

/**
 * What the mailer sent and what failed, for metrics, alerting and an audit trail. Every
 * event is also published on its `node:diagnostics_channel` channel
 * (`nestjs:mail:sent`, `nestjs:mail:failed`), where instrumentation can subscribe
 * without depending on Nest. `events$` completes on application shutdown, after the
 * sends still in flight have finished.
 */
@Injectable()
export class MailEvents {
  private readonly subject = new MailEventSubject();
  readonly events$: MailEventStream = this.subject.asStream();

  /** @internal Called by the mailer. */
  emit(event: MailEvent): void {
    const target = channels[event.type];
    if (target.hasSubscribers) {
      target.publish(event);
    }
    this.subject.next(event);
  }

  /** @internal Called by `MailModule` in `onApplicationShutdown`, once the mailer has drained. */
  complete(): void {
    this.subject.complete();
  }
}
