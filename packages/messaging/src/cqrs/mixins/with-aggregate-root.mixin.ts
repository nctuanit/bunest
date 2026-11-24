import type {
  AbstractConstructor,
  ApplyEventOptions,
  IAggregateRoot,
  IEvent,
} from "../interfaces";

const INTERNAL_EVENTS = Symbol("bunest:cqrs:internal-events");
const IS_AUTO_COMMIT_ENABLED = Symbol("bunest:cqrs:auto-commit");

class EmptyBase {}

/**
 * Mixin adding full `AggregateRoot` event-sourcing capabilities to any base entity class.
 */
export function WithAggregateRoot<
  EventBase extends IEvent = IEvent,
  TBase extends AbstractConstructor = AbstractConstructor<{}>,
>(
  Base: TBase = EmptyBase as unknown as TBase,
): abstract new <T extends IEvent = EventBase>(
  ...args: any[]
) => IAggregateRoot<T> & InstanceType<TBase> {
  abstract class AggregateRootMixin extends Base {
    [IS_AUTO_COMMIT_ENABLED] = false;
    readonly [INTERNAL_EVENTS]: EventBase[] = [];

    set autoCommit(value: boolean) {
      this[IS_AUTO_COMMIT_ENABLED] = value;
    }

    get autoCommit(): boolean {
      return this[IS_AUTO_COMMIT_ENABLED];
    }

    publish<T extends EventBase = EventBase>(
      _event: T,
      _dispatcherContext?: unknown,
    ): any {
      // No-op until merged with EventPublisher or @Publishable()
    }

    async publishAll<T extends EventBase = EventBase>(
      events: readonly T[],
      dispatcherContext?: unknown,
    ): Promise<void> {
      for (const event of events) {
        await this.publish(event, dispatcherContext);
      }
    }

    commit(dispatcherContext?: unknown): any {
      const events = this[INTERNAL_EVENTS];
      if (events.length === 0) {
        return Promise.resolve();
      }
      const copy = events.splice(0, events.length);
      return dispatcherContext === undefined
        ? this.publishAll(copy)
        : this.publishAll(copy, dispatcherContext);
    }

    uncommit(): void {
      this[INTERNAL_EVENTS].length = 0;
    }

    getUncommittedEvents(): EventBase[] {
      return [...this[INTERNAL_EVENTS]];
    }

    loadFromHistory(history: readonly EventBase[]): void {
      for (const event of history) {
        this.apply(event, { fromHistory: true });
      }
    }

    apply<T extends EventBase = EventBase>(
      event: T,
      isFromHistory?: boolean,
    ): void;
    apply<T extends EventBase = EventBase>(
      event: T,
      options?: ApplyEventOptions,
    ): void;
    apply<T extends EventBase = EventBase>(
      event: T,
      optionsOrIsFromHistory: boolean | ApplyEventOptions = {},
    ): void {
      const isFromHistory =
        typeof optionsOrIsFromHistory === "boolean"
          ? optionsOrIsFromHistory
          : (optionsOrIsFromHistory.fromHistory ?? false);
      const skipHandler =
        typeof optionsOrIsFromHistory === "boolean"
          ? false
          : (optionsOrIsFromHistory.skipHandler ?? false);

      // Apply internal state mutation BEFORE publishing/buffering so autoCommit
      // subscribers always observe the updated aggregate state.
      if (!skipHandler) {
        const handler = this.getEventHandler(event);
        if (handler) {
          handler.call(this, event);
        }
      }

      if (!isFromHistory) {
        if (this[IS_AUTO_COMMIT_ENABLED]) {
          void this.publish(event);
        } else {
          this[INTERNAL_EVENTS].push(event);
        }
      }
    }

    protected getEventHandler<T extends EventBase = EventBase>(
      event: T,
    ): ((event: T) => void) | undefined {
      const eventName = this.getEventName(event);
      if (!eventName) {
        return undefined;
      }
      const handler = (this as Record<string, unknown>)[`on${eventName}`];
      return typeof handler === "function"
        ? (handler as (event: T) => void)
        : undefined;
    }

    protected getEventName(event: unknown): string {
      if (!event || typeof event !== "object") {
        return "";
      }
      const proto = Object.getPrototypeOf(event) as {
        constructor?: Function;
      } | null;
      return (
        proto?.constructor?.name ??
        (event as { constructor?: Function }).constructor?.name ??
        ""
      );
    }
  }

  return AggregateRootMixin as unknown as abstract new <
    T extends IEvent = EventBase,
  >(
    ...args: any[]
  ) => IAggregateRoot<T> & InstanceType<TBase>;
}
