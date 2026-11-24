import type { Type } from "@bunest/core";
import type { IAggregateRoot, IEvent, IEventBus } from "../interfaces";

/**
 * Registry of `@Publishable()` aggregate classes whose prototypes are bound to
 * the active `EventBus` during `CqrsModule.onApplicationBootstrap()`.
 */
export class AggregateRootStorage {
  private static readonly storage = new Set<Type<IAggregateRoot<any>>>();

  static add(type: Type<IAggregateRoot<any>>): void {
    this.storage.add(type);
  }

  static mergeContext(eventBus: IEventBus<any>): void {
    for (const item of this.storage) {
      item.prototype.publish = function <TEvent extends IEvent>(
        event: TEvent,
        dispatcherContext?: unknown,
      ) {
        return dispatcherContext === undefined
          ? eventBus.publish(event)
          : eventBus.publish(event, dispatcherContext);
      };
      item.prototype.publishAll = function <TEvent extends IEvent>(
        events: readonly TEvent[],
        dispatcherContext?: unknown,
      ) {
        return dispatcherContext === undefined
          ? eventBus.publishAll(events)
          : eventBus.publishAll(events, dispatcherContext);
      };
    }
  }

  static getRegistered(): readonly Type<IAggregateRoot<any>>[] {
    return [...this.storage];
  }

  static clear(): void {
    this.storage.clear();
  }
}
