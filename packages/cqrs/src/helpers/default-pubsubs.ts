import { MetadataRegistry, type Type } from "@bunest/common";
import type {
  EventIdProvider,
  EventMetadata,
  ICommand,
  ICommandPublisher,
  IEvent,
  IEventPublisher,
  IMessageSource,
  IQuery,
  IQueryPublisher,
  IUnhandledExceptionPublisher,
  UnhandledExceptionInfo,
} from "../interfaces";
import { EVENT_METADATA } from "../tokens";
import type { SubjectLike } from "../utils/subscribable-stream";

/**
 * Default in-memory command publisher forwarding dispatched commands to a subject stream.
 */
export class DefaultCommandPubSub<CommandBase extends ICommand = ICommand>
  implements ICommandPublisher<CommandBase>
{
  constructor(private readonly subject$: SubjectLike<CommandBase>) {}

  publish<T extends CommandBase>(command: T): void {
    this.subject$.next(command);
  }
}

/**
 * Default in-memory query publisher forwarding dispatched queries to a subject stream.
 */
export class DefaultQueryPubSub<QueryBase extends IQuery = IQuery>
  implements IQueryPublisher<QueryBase>
{
  constructor(private readonly subject$: SubjectLike<QueryBase>) {}

  publish<T extends QueryBase>(query: T): void {
    this.subject$.next(query);
  }
}

/**
 * Default in-memory event publisher & message source.
 */
export class DefaultPubSub<EventBase extends IEvent = IEvent>
  implements IEventPublisher<EventBase>, IMessageSource<EventBase>
{
  constructor(private subject$: SubjectLike<EventBase>) {}

  publish<T extends EventBase>(event: T): void {
    this.subject$.next(event);
  }

  bridgeEventsTo<T extends EventBase>(subject: SubjectLike<T>): void {
    this.subject$ = subject as unknown as SubjectLike<EventBase>;
  }
}

/**
 * Default in-memory publisher for `UnhandledExceptionBus`.
 */
export class DefaultUnhandledExceptionPubSub<Cause = IEvent | ICommand>
  implements IUnhandledExceptionPublisher<Cause>
{
  constructor(
    private readonly subject$: SubjectLike<UnhandledExceptionInfo<Cause>>,
  ) {}

  publish(info: UnhandledExceptionInfo<Cause>): void {
    this.subject$.next(info);
  }
}

/**
 * Default event ID provider reading metadata attached by `@EventsHandler()`
 * (falling back to the event constructor name).
 */
export class DefaultEventIdProvider<EventBase extends IEvent = IEvent>
  implements EventIdProvider<EventBase>
{
  getEventId(event: Type<EventBase>): string | null {
    if (!event) {
      return null;
    }
    const ctor =
      typeof event === "function"
        ? event
        : (Object.getPrototypeOf(event)?.constructor as Function | undefined);
    if (!ctor) {
      return null;
    }
    const meta = MetadataRegistry.get<EventMetadata>(EVENT_METADATA, ctor);
    if (meta?.id) {
      return meta.id;
    }
    return ctor.name || null;
  }
}

export const defaultEventIdProvider = new DefaultEventIdProvider<IEvent>();
