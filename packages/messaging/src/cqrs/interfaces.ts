import type {
  FactoryDependency,
  ModuleImport,
  Provider,
  Type,
} from "@bunest/core";
import type {
  AbstractConstructor,
  Constructor,
  ICommand,
  IEvent,
  IQuery,
  IQueryResult,
} from "./classes/base-types";
import type { Command, CommandResult } from "./classes/command";
import type { Query, QueryResult } from "./classes/query";
import type {
  RegisteredCommandResult,
  RegisteredQueryResult,
} from "./cqrs-registry.interface";
import type { AsyncContext } from "./scopes/async.context";
import type { SubjectLike } from "./utils/subscribable-stream";

export type {
  AbstractConstructor,
  CommandResult,
  Constructor,
  ICommand,
  IEvent,
  IQuery,
  IQueryResult,
  QueryResult,
};

/**
 * Command handler contract supporting automatic result-type inference when
 * `TCommand extends Command<TResult>`, as well as plain `ICommand` implementations.
 */
export type ICommandHandler<TCommand extends ICommand = any, TResult = any> =
  TCommand extends Command<infer InferredCommandResult>
    ? {
        execute(
          command: TCommand,
        ): Promise<InferredCommandResult> | InferredCommandResult;
      }
    : {
        execute(command: TCommand): Promise<TResult> | TResult;
      };

/**
 * Query handler contract supporting automatic result-type inference when
 * `TQuery extends Query<TResult>`, as well as plain `IQuery` implementations.
 */
export type IQueryHandler<TQuery extends IQuery = any, TResult = any> =
  TQuery extends Query<infer InferredQueryResult>
    ? {
        execute(
          query: TQuery,
        ): Promise<InferredQueryResult> | InferredQueryResult;
      }
    : {
        execute(query: TQuery): Promise<TResult> | TResult;
      };

export interface IEventHandler<TEvent extends IEvent = any> {
  handle(event: TEvent): unknown;
}

export type CommandHandlerType<T extends ICommand = ICommand> = Type<
  ICommandHandler<T>
>;

export type QueryHandlerType<
  QueryBase extends IQuery = IQuery,
  QueryResultBase extends IQueryResult = IQueryResult,
> = Type<IQueryHandler<QueryBase, QueryResultBase>>;

export type EventHandlerType<EventBase extends IEvent = IEvent> = Type<
  IEventHandler<EventBase>
>;

export interface ICommandBus<CommandBase extends ICommand = ICommand> {
  execute<R = void>(command: Command<R>): Promise<R>;
  execute<R = void>(command: Command<R>, context?: AsyncContext): Promise<R>;
  execute<TCommand extends CommandBase>(
    command: [RegisteredCommandResult<TCommand>] extends [never]
      ? never
      : TCommand,
    context?: AsyncContext,
  ): Promise<RegisteredCommandResult<TCommand>>;
  execute<TResult = any, TCommand extends CommandBase = CommandBase>(
    command: TCommand,
    context?: AsyncContext,
  ): Promise<TResult>;
  execute<TCommand extends CommandBase, TResult = any>(
    command: TCommand,
    context?: AsyncContext,
  ): Promise<TResult>;
}

export interface IQueryBus<QueryBase extends IQuery = IQuery> {
  execute<TResult>(query: Query<TResult>): Promise<TResult>;
  execute<TResult>(
    query: Query<TResult>,
    asyncContext: AsyncContext,
  ): Promise<TResult>;
  execute<TQuery extends QueryBase>(
    query: [RegisteredQueryResult<TQuery>] extends [never] ? never : TQuery,
    asyncContext?: AsyncContext,
  ): Promise<RegisteredQueryResult<TQuery>>;
  execute<TResult = any, TQuery extends QueryBase = QueryBase>(
    query: TQuery,
    asyncContext?: AsyncContext,
  ): Promise<TResult>;
  execute<TQuery extends QueryBase, TResult = any>(
    query: TQuery,
    asyncContext?: AsyncContext,
  ): Promise<TResult>;
}

export interface IEventBus<EventBase extends IEvent = IEvent> {
  publish<TEvent extends EventBase>(event: TEvent): any;
  publish<TEvent extends EventBase>(
    event: TEvent,
    asyncContext: AsyncContext,
  ): any;
  publish<TEvent extends EventBase, TContext = unknown>(
    event: TEvent,
    dispatcherContext: TContext,
  ): any;
  publish<TEvent extends EventBase, TContext = unknown>(
    event: TEvent,
    dispatcherContext: TContext,
    asyncContext: AsyncContext,
  ): any;

  publishAll<TEvent extends EventBase>(events: readonly TEvent[]): any;
  publishAll<TEvent extends EventBase>(
    events: readonly TEvent[],
    asyncContext: AsyncContext,
  ): any;
  publishAll<TEvent extends EventBase, TContext = unknown>(
    events: readonly TEvent[],
    dispatcherContext: TContext,
  ): any;
  publishAll<TEvent extends EventBase, TContext = unknown>(
    events: readonly TEvent[],
    dispatcherContext: TContext,
    asyncContext: AsyncContext,
  ): any;
}

export interface ICommandPublisher<CommandBase extends ICommand = ICommand> {
  publish<T extends CommandBase = CommandBase>(command: T): any;
}

export interface IQueryPublisher<QueryBase extends IQuery = IQuery> {
  publish<T extends QueryBase = QueryBase>(query: T): any;
}

export interface IEventPublisher<EventBase extends IEvent = IEvent> {
  publish<TEvent extends EventBase>(
    event: TEvent,
    dispatcherContext?: unknown,
    asyncContext?: AsyncContext,
  ): any;
  publishAll?<TEvent extends EventBase>(
    events: readonly TEvent[],
    dispatcherContext?: unknown,
    asyncContext?: AsyncContext,
  ): any;
}

export interface IMessageSource<EventBase extends IEvent = IEvent> {
  bridgeEventsTo<T extends EventBase>(subject: SubjectLike<T>): any;
}

export interface EventIdProvider<EventBase extends IEvent = IEvent> {
  getEventId(event: Type<EventBase>): string | null;
}

export interface UnhandledExceptionInfo<
  Cause = IEvent | ICommand,
  Exception = unknown,
> {
  exception: Exception;
  cause: Cause;
}

export interface IUnhandledExceptionPublisher<
  CauseBase = IEvent | ICommand,
  ExceptionBase = unknown,
> {
  publish(info: UnhandledExceptionInfo<CauseBase, ExceptionBase>): unknown;
}

export interface ApplyEventOptions {
  /**
   * When `true`, replays state handler without recording the event as uncommitted.
   */
  readonly fromHistory?: boolean;

  /**
   * When `true`, skips invoking the `on<EventName>()` convention handler on the aggregate.
   */
  readonly skipHandler?: boolean;
}

export interface IAggregateRoot<EventBase extends IEvent = IEvent> {
  autoCommit: boolean;
  publish<T extends EventBase = EventBase>(
    event: T,
    dispatcherContext?: unknown,
  ): any;
  publishAll<T extends EventBase = EventBase>(
    events: readonly T[],
    dispatcherContext?: unknown,
  ): any;
  commit(dispatcherContext?: unknown): any;
  uncommit(): void;
  getUncommittedEvents(): EventBase[];
  loadFromHistory(history: readonly EventBase[]): void;
  apply<T extends EventBase = EventBase>(
    event: T,
    isFromHistory?: boolean,
  ): void;
  apply<T extends EventBase = EventBase>(
    event: T,
    options?: ApplyEventOptions,
  ): void;
}

export type SagaOutput =
  | ICommand
  | readonly ICommand[]
  | AsyncIterable<ICommand>
  | Iterable<ICommand>
  | void
  | null
  | undefined;

/**
 * Saga function reacting to published domain events and optionally yielding
 * one or more follow-up commands to be executed on `CommandBus`.
 */
export type ISaga<TEvent extends IEvent = IEvent> = (
  event: TEvent,
) => Promise<SagaOutput> | SagaOutput;

export type EventSubscriber<TEvent extends IEvent = IEvent> = (
  event: TEvent,
) => Promise<void> | void;

export type SagaErrorHandler = (error: unknown, event: IEvent) => void;

export type SagaErrorStrategy = "complete" | "resubscribe";

export interface SagaMethodMetadata {
  readonly methodName: string | symbol;
}

export interface CommandMetadata {
  readonly id: string;
}

export interface QueryMetadata {
  readonly id: string;
}

export interface EventMetadata {
  readonly id: string;
}

export interface CqrsModuleOptions {
  /**
   * Register `CqrsModule` globally so `CommandBus`, `QueryBus`, `EventBus`,
   * `UnhandledExceptionBus`, and `EventPublisher` are injectable across all modules.
   * @default true
   */
  readonly global?: boolean;

  /**
   * Optional error hook called whenever a saga or follow-up saga command throws.
   */
  readonly onSagaError?: SagaErrorHandler;

  /**
   * Custom command publisher (defaults to `DefaultCommandPubSub`).
   */
  commandPublisher?: ICommandPublisher;

  /**
   * Custom event publisher (defaults to `DefaultPubSub`).
   */
  eventPublisher?: IEventPublisher;

  /**
   * Custom query publisher (defaults to `DefaultQueryPubSub`).
   */
  queryPublisher?: IQueryPublisher;

  /**
   * Custom unhandled exception publisher (defaults to `DefaultUnhandledExceptionPubSub`).
   */
  unhandledExceptionPublisher?: IUnhandledExceptionPublisher;

  /**
   * Custom event ID provider for matching events to handlers.
   */
  eventIdProvider?: EventIdProvider;

  /**
   * Whether unhandled event handler / saga errors should rethrow instead of only
   * being dispatched to `UnhandledExceptionBus`.
   */
  rethrowUnhandled?: boolean;

  /**
   * Controls how a saga behaves after throwing when `rethrowUnhandled` is not set.
   * - `'complete'`: stops the saga after an error.
   * - `'resubscribe'`: pauses and automatically resumes with exponential backoff (100ms -> 30s).
   */
  sagaErrorStrategy?: SagaErrorStrategy;
}

export interface CqrsModuleOptionsFactory {
  createCqrsOptions(): Promise<CqrsModuleOptions> | CqrsModuleOptions;
}

export interface CqrsModuleAsyncOptions {
  imports?: ModuleImport[];
  useExisting?: Type<CqrsModuleOptionsFactory>;
  useClass?: Type<CqrsModuleOptionsFactory>;
  useFactory?: (
    ...args: any[]
  ) => Promise<CqrsModuleOptions> | CqrsModuleOptions;
  useValue?: CqrsModuleOptions;
  inject?: FactoryDependency[];
  extraProviders?: Provider[];
  global?: boolean;
}

export type CommandType<T extends ICommand = ICommand> = Type<T>;
export type QueryType<T extends IQuery = IQuery> = Type<T>;
export type EventType<T extends IEvent = IEvent> = Type<T>;
