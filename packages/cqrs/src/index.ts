import "reflect-metadata";

export {
  COMMAND_HANDLER_METADATA,
  COMMAND_METADATA,
  CQRS_MODULE_OPTIONS,
  EVENTS_HANDLER_METADATA,
  EVENT_METADATA,
  QUERY_HANDLER_METADATA,
  QUERY_METADATA,
  SAGA_METADATA,
} from "./tokens";

export { RESULT_TYPE_SYMBOL } from "./classes/base-types";
export { Command, type CommandResult } from "./classes/command";
export { Query, type QueryResult } from "./classes/query";
export {
  ASYNC_CONTEXT_ATTRIBUTE,
  AsyncContext,
} from "./scopes/async.context";
export {
  SubscribableStream,
  type ObserverLike,
  type StreamListener,
  type SubjectLike,
  type Subscribable,
  type SubscriptionHandle,
} from "./utils/subscribable-stream";

export type {
  AbstractConstructor,
  ApplyEventOptions,
  CommandHandlerType,
  CommandMetadata,
  CommandType,
  Constructor,
  CqrsModuleAsyncOptions,
  CqrsModuleOptions,
  CqrsModuleOptionsFactory,
  EventHandlerType,
  EventIdProvider,
  EventMetadata,
  EventSubscriber,
  EventType,
  IAggregateRoot,
  ICommand,
  ICommandBus,
  ICommandHandler,
  ICommandPublisher,
  IEvent,
  IEventBus,
  IEventHandler,
  IEventPublisher,
  IMessageSource,
  IQuery,
  IQueryBus,
  IQueryHandler,
  IQueryPublisher,
  IQueryResult,
  ISaga,
  IUnhandledExceptionPublisher,
  QueryHandlerType,
  QueryMetadata,
  QueryType,
  SagaErrorHandler,
  SagaErrorStrategy,
  SagaMethodMetadata,
  SagaOutput,
  UnhandledExceptionInfo,
} from "./interfaces";

export {
  CommandHandlerNotFoundException,
  DuplicateCommandHandlerException,
  DuplicateQueryHandlerException,
  InvalidCommandHandlerException,
  InvalidEventsHandlerException,
  InvalidQueryHandlerException,
  InvalidSagaException,
  QueryHandlerNotFoundException,
  UnsupportedSagaScopeException,
} from "./exceptions";

export {
  DefaultCommandPubSub,
  DefaultEventIdProvider,
  DefaultPubSub,
  DefaultQueryPubSub,
  DefaultUnhandledExceptionPubSub,
  defaultEventIdProvider,
} from "./helpers/default-pubsubs";

export { WithAggregateRoot } from "./mixins/with-aggregate-root.mixin";
export { AggregateRootStorage } from "./storages/aggregate-root.storage";

export {
  CommandHandler,
  EventsHandler,
  Publishable,
  QueryHandler,
  Saga,
} from "./decorators";

export { UnhandledExceptionBus } from "./unhandled-exception-bus";
export { CommandBus } from "./command-bus";
export { QueryBus } from "./query-bus";
export { EventBus } from "./event-bus";
export { AggregateRoot } from "./aggregate-root";
export { EventPublisher } from "./event-publisher";
export { CqrsExplorer, CqrsModule } from "./cqrs.module";
