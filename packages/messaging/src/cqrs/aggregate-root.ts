import type { ApplyEventOptions, IAggregateRoot, IEvent } from "./interfaces";

export type { ApplyEventOptions };

/**
 * Domain aggregate base class buffering uncommitted domain events until `commit()`
 * dispatches them via `EventPublisher` / `@Publishable()` / `EventBus`.
 */
export abstract class AggregateRoot<
  EventBase extends IEvent = IEvent,
> implements IAggregateRoot<EventBase> {
  private readonly internalEvents: EventBase[] = [];
  private autoCommitEnabled = false;

  set autoCommit(value: boolean) {
    this.autoCommitEnabled = value;
  }

  get autoCommit(): boolean {
    return this.autoCommitEnabled;
  }

  /**
   * Applies a domain event to the aggregate, invoking an optional `on<EventName>()`
   * method and either buffering it (default) or publishing immediately when `autoCommit` is true.
   */
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
    const fromHistory =
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

    if (!fromHistory) {
      if (this.autoCommitEnabled) {
        void this.publish(event);
      } else {
        this.internalEvents.push(event);
      }
    }
  }

  /**
   * Publishes all uncommitted events in order and clears the internal buffer.
   */
  commit(dispatcherContext?: unknown): Promise<void> | any {
    if (dispatcherContext === undefined) {
      const result = this.publishAll(this.internalEvents);
      this.internalEvents.length = 0;
      return result;
    }
    const events = [...this.internalEvents];
    const result = this.publishAll(events, dispatcherContext);
    this.internalEvents.length = 0;
    return result;
  }

  /**
   * Discards all buffered uncommitted events without publishing.
   */
  uncommit(): void {
    this.internalEvents.length = 0;
  }

  /**
   * Returns the internal array of currently buffered uncommitted events.
   */
  getUncommittedEvents(): EventBase[] {
    return this.internalEvents;
  }

  /**
   * Rehydrates aggregate state by replaying historical events without buffering them.
   */
  loadFromHistory(history: readonly EventBase[]): void {
    for (const event of history) {
      this.apply(event, { fromHistory: true });
    }
  }

  /**
   * Bound by `EventPublisher.mergeObjectContext()`, `mergeClassContext()`, or `@Publishable()`.
   */
  publish<T extends EventBase = EventBase>(
    _event: T,
    _dispatcherContext?: unknown,
  ): Promise<void> | any {
    // No-op until merged with EventPublisher or @Publishable()
  }

  /**
   * Bound by `EventPublisher.mergeObjectContext()`, `mergeClassContext()`, or `@Publishable()`.
   */
  async publishAll<T extends EventBase = EventBase>(
    events: readonly T[],
    dispatcherContext?: unknown,
  ): Promise<void> {
    for (const event of events) {
      await this.publish(event, dispatcherContext);
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
    const ctor = (event as { constructor?: Function }).constructor;
    return proto?.constructor?.name ?? ctor?.name ?? "";
  }
}
