export type PubSubListener<T = unknown> = (payload: T) => void;

export interface PubSubEngine {
  publish<T = unknown>(triggerName: string, payload: T): Promise<void>;
  subscribe<T = unknown>(
    triggerName: string,
    onMessage: PubSubListener<T>,
  ): Promise<number>;
  unsubscribe(subId: number): void;
  asyncIterator<T = unknown>(
    triggers: string | readonly string[],
  ): AsyncIterableIterator<T>;
}

/**
 * Built-in in-memory typed PubSub engine powering `@Subscription()` resolvers
 * with clean backpressure queuing and guaranteed listener teardown on `return()`.
 */
export class PubSub implements PubSubEngine {
  private nextSubId = 1;
  private readonly subscriptions = new Map<
    number,
    { readonly trigger: string; readonly listener: PubSubListener<any> }
  >();
  private readonly triggerToSubs = new Map<string, Set<number>>();

  async publish<T = unknown>(triggerName: string, payload: T): Promise<void> {
    const ids = this.triggerToSubs.get(triggerName);
    if (!ids || ids.size === 0) {
      return;
    }
    const snapshot = [...ids];
    for (let i = 0; i < snapshot.length; i++) {
      const subId = snapshot[i]!;
      const entry = this.subscriptions.get(subId);
      if (entry) {
        entry.listener(payload);
      }
    }
  }

  async subscribe<T = unknown>(
    triggerName: string,
    onMessage: PubSubListener<T>,
  ): Promise<number> {
    const id = this.nextSubId++;
    this.subscriptions.set(id, { trigger: triggerName, listener: onMessage });
    let bucket = this.triggerToSubs.get(triggerName);
    if (!bucket) {
      bucket = new Set();
      this.triggerToSubs.set(triggerName, bucket);
    }
    bucket.add(id);
    return id;
  }

  unsubscribe(subId: number): void {
    const entry = this.subscriptions.get(subId);
    if (!entry) return;
    this.subscriptions.delete(subId);
    const bucket = this.triggerToSubs.get(entry.trigger);
    if (bucket) {
      bucket.delete(subId);
      if (bucket.size === 0) {
        this.triggerToSubs.delete(entry.trigger);
      }
    }
  }

  listenerCount(triggerName?: string): number {
    if (triggerName !== undefined) {
      return this.triggerToSubs.get(triggerName)?.size ?? 0;
    }
    return this.subscriptions.size;
  }

  asyncIterator<T = unknown>(
    triggers: string | readonly string[],
  ): AsyncIterableIterator<T, undefined> {
    const triggerList =
      typeof triggers === "string" ? [triggers] : [...triggers];
    const pushQueue: T[] = [];
    const pullQueue: Array<(result: IteratorResult<T, undefined>) => void> = [];
    const subIds: number[] = [];
    let closed = false;

    const pushValue = (event: T) => {
      if (closed) return;
      if (pullQueue.length > 0) {
        const resolve = pullQueue.shift()!;
        resolve({ value: event, done: false });
      } else {
        pushQueue.push(event);
      }
    };

    for (let i = 0; i < triggerList.length; i++) {
      const trigger = triggerList[i];
      if (!trigger) continue;
      // Register synchronously so messages published right after asyncIterator() are never missed
      const id = this.nextSubId++;
      this.subscriptions.set(id, { trigger, listener: pushValue });
      let bucket = this.triggerToSubs.get(trigger);
      if (!bucket) {
        bucket = new Set();
        this.triggerToSubs.set(trigger, bucket);
      }
      bucket.add(id);
      subIds.push(id);
    }

    const cleanup = () => {
      if (closed) return;
      closed = true;
      for (let i = 0; i < subIds.length; i++) {
        this.unsubscribe(subIds[i]!);
      }
      subIds.length = 0;
      pushQueue.length = 0;
      while (pullQueue.length > 0) {
        const resolve = pullQueue.shift()!;
        resolve({ value: undefined, done: true });
      }
    };

    const iterator: AsyncIterableIterator<T, undefined> = {
      [Symbol.asyncIterator]() {
        return iterator;
      },
      next(): Promise<IteratorResult<T, undefined>> {
        if (pushQueue.length > 0) {
          return Promise.resolve({ value: pushQueue.shift()!, done: false });
        }
        if (closed) {
          return Promise.resolve({
            value: undefined,
            done: true,
          });
        }
        return new Promise<IteratorResult<T, undefined>>((resolve) => {
          pullQueue.push(resolve);
        });
      },
      return(): Promise<IteratorResult<T, undefined>> {
        cleanup();
        return Promise.resolve({
          value: undefined,
          done: true,
        });
      },
      throw(error?: unknown): Promise<IteratorResult<T, undefined>> {
        cleanup();
        return Promise.reject(error);
      },
    };

    return iterator;
  }
}

/**
 * Wraps an `AsyncIterable` factory with an async predicate filter, forwarding
 * `return()` cleanly to the underlying iterator on disconnect.
 */
export function withFilter<TPayload = any, TVariables = any>(
  asyncIteratorFn: (
    rootValue?: any,
    args?: TVariables,
    context?: any,
    info?: any,
  ) => AsyncIterable<TPayload> | Promise<AsyncIterable<TPayload>>,
  filterFn: (
    payload: TPayload,
    variables: TVariables,
    context: any,
    info: any,
  ) => boolean | Promise<boolean>,
): (
  rootValue?: any,
  args?: TVariables,
  context?: any,
  info?: any,
) => AsyncIterableIterator<TPayload> {
  return (rootValue, args, context, info) => {
    let sourceIterator: AsyncIterator<TPayload> | undefined;
    let closed = false;

    const ensureSource = async (): Promise<AsyncIterator<TPayload>> => {
      if (!sourceIterator) {
        const iterable = await asyncIteratorFn(rootValue, args, context, info);
        sourceIterator = iterable[Symbol.asyncIterator]();
      }
      return sourceIterator;
    };

    const filtered: AsyncIterableIterator<TPayload, undefined> = {
      [Symbol.asyncIterator]() {
        return filtered;
      },
      async next(): Promise<IteratorResult<TPayload, undefined>> {
        if (closed) {
          return { value: undefined, done: true };
        }
        const src = await ensureSource();
        while (!closed) {
          const step = await src.next();
          if (step.done) {
            return { value: undefined, done: true };
          }
          const matched = await filterFn(
            step.value,
            args as TVariables,
            context,
            info,
          );
          if (matched) {
            return { value: step.value, done: false };
          }
        }
        return { value: undefined, done: true };
      },
      async return(): Promise<IteratorResult<TPayload, undefined>> {
        closed = true;
        if (sourceIterator && typeof sourceIterator.return === "function") {
          await sourceIterator.return();
        }
        return { value: undefined, done: true };
      },
      async throw(error?: unknown): Promise<IteratorResult<TPayload, undefined>> {
        closed = true;
        if (sourceIterator && typeof sourceIterator.return === "function") {
          await sourceIterator.return();
        }
        return Promise.reject(error);
      },
    };

    return filtered;
  };
}
