import { Injectable } from "@bunest/core";
import { EventBus } from "./event-bus";
import type { Constructor, IAggregateRoot, IEvent } from "./interfaces";
import type { AsyncContext } from "./scopes/async.context";

/**
 * Connects `AggregateRoot` instances or classes to `EventBus` so `aggregate.commit()`
 * publishes uncommitted domain events onto the bus (propagating `dispatcherContext`
 * and optional `AsyncContext`).
 */
@Injectable()
export class EventPublisher<EventBase extends IEvent = IEvent> {
  constructor(private readonly eventBus: EventBus<EventBase>) {}

  mergeObjectContext<T extends IAggregateRoot<EventBase>>(
    object: T,
    asyncContext?: AsyncContext,
  ): T {
    const eventBus = this.eventBus;
    object.publish = <TEvent extends EventBase>(
      event: TEvent,
      dispatcherContext?: unknown,
    ) => {
      const ctx = dispatcherContext === undefined ? object : dispatcherContext;
      return eventBus.publish(event, ctx, asyncContext as AsyncContext);
    };
    object.publishAll = <TEvent extends EventBase>(
      events: readonly TEvent[],
      dispatcherContext?: unknown,
    ) => {
      const ctx = dispatcherContext === undefined ? object : dispatcherContext;
      return eventBus.publishAll(events, ctx, asyncContext as AsyncContext);
    };
    return object;
  }

  mergeClassContext<T extends Constructor<IAggregateRoot<EventBase>>>(
    metatype: T,
    asyncContext?: AsyncContext,
  ): T {
    const eventBus = this.eventBus;
    return class extends metatype {
      override publish<TEvent extends EventBase>(
        event: TEvent,
        dispatcherContext?: unknown,
      ): Promise<void> {
        const ctx = dispatcherContext === undefined ? this : dispatcherContext;
        return eventBus.publish(event, ctx, asyncContext as AsyncContext);
      }

      override publishAll<TEvent extends EventBase>(
        events: readonly TEvent[],
        dispatcherContext?: unknown,
      ): Promise<void> {
        const ctx = dispatcherContext === undefined ? this : dispatcherContext;
        return eventBus.publishAll(events, ctx, asyncContext as AsyncContext);
      }
    };
  }
}
