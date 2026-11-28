import {
  Inject,
  Injectable,
  Logger,
  MetadataRegistry,
  Optional,
  Scope,
  type OnModuleDestroy,
  type Type,
} from "@bunest/core";
import { ModuleRef, type InstanceWrapper } from "@bunest/core";
import { isFunction } from "@bunest/core/common";
import { CommandBus } from "./command-bus";
import {
  InvalidEventsHandlerException,
  InvalidSagaException,
  UnsupportedSagaScopeException,
} from "./exceptions";
import {
  DefaultPubSub,
  defaultEventIdProvider,
} from "./helpers/default-pubsubs";
import type {
  CqrsModuleOptions,
  EventIdProvider,
  EventSubscriber,
  EventType,
  ICommand,
  IEvent,
  IEventBus,
  IEventHandler,
  IEventPublisher,
  ISaga,
  SagaErrorHandler,
  SagaMethodMetadata,
  SagaOutput,
  UnhandledExceptionInfo,
} from "./interfaces";
import { AsyncContext } from "./scopes/async.context";
import {
  CQRS_MODULE_OPTIONS,
  EVENTS_HANDLER_METADATA,
  SAGA_METADATA,
} from "./tokens";
import { UnhandledExceptionBus } from "./unhandled-exception-bus";
import {
  SubscribableStream,
  type StreamListener,
  type Subscribable,
  type SubscriptionHandle,
} from "./utils/subscribable-stream";

type StoredEventHandler<EventBase extends IEvent> =
  | {
      readonly kind: "instance";
      readonly handler: IEventHandler<EventBase>;
    }
  | {
      readonly kind: "wrapper";
      readonly wrapper: InstanceWrapper<IEventHandler<EventBase>>;
    };

interface SagaEntry<EventBase extends IEvent> {
  readonly fn: ISaga<EventBase>;
  readonly name?: string;
  disabled: boolean;
  pausedUntil: number;
  backoffMs: number;
  lastErrorAt: number;
  resumeTimer?: ReturnType<typeof setTimeout>;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<ICommand> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] ===
      "function"
  );
}

function isCommandIterable(value: unknown): value is Iterable<ICommand> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value !== "string" &&
    Symbol.iterator in value &&
    typeof (value as Iterable<unknown>)[Symbol.iterator] === "function"
  );
}

function isInstanceWrapperLike(
  value: unknown,
): value is InstanceWrapper<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "token" in value &&
    "moduleRef" in value
  );
}

function collectMergedClassArray<T>(key: symbol, target: Function): T[] {
  const chain: Function[] = [];
  let cursor: Function | null = target;
  while (cursor && cursor !== Function.prototype && cursor !== Object) {
    chain.push(cursor);
    const parent = Object.getPrototypeOf(cursor);
    cursor = typeof parent === "function" ? parent : null;
  }
  chain.reverse();

  const merged: T[] = [];
  for (const ctor of chain) {
    const own = MetadataRegistry.getOwn<readonly T[]>(key, ctor);
    if (own) {
      merged.push(...own);
    }
  }
  return merged;
}

/**
 * Publishes domain events to all registered `@EventsHandler()` listeners,
 * ad-hoc subscribers, and `@Saga()` workflows.
 * Supports pluggable `IEventPublisher`, `AsyncContext`, `UnhandledExceptionBus`,
 * `rethrowUnhandled`, `sagaErrorStrategy`, and zero-RxJS subscribable `subject$`.
 */
@Injectable()
export class EventBus<EventBase extends IEvent = IEvent>
  implements IEventBus<EventBase>, Subscribable<EventBase>, OnModuleDestroy
{
  readonly subject$ = new SubscribableStream<EventBase>();

  protected eventIdProvider: EventIdProvider<EventBase>;
  private readonly handlers = new Map<
    Function,
    Set<StoredEventHandler<EventBase>>
  >();
  private readonly handlersById = new Map<
    string,
    Set<StoredEventHandler<EventBase>>
  >();
  private readonly subscribers = new Set<EventSubscriber<EventBase>>();
  private readonly sagas = new Set<SagaEntry<EventBase>>();
  private readonly sagaErrorHandlers = new Set<SagaErrorHandler>();
  private readonly inFlightSagas = new Set<Promise<void>>();
  private readonly logger = new Logger("EventBus");
  private readonly defaultPublisher: DefaultPubSub<EventBase>;
  private _publisher: IEventPublisher<EventBase>;
  private readonly bridgeListener: (event: EventBase) => Promise<void>;
  private readonly bridgeUnsubscribe: SubscriptionHandle;

  constructor(
    private readonly commandBus: CommandBus,
    @Optional() private readonly moduleRef?: ModuleRef,
    @Optional()
    private readonly unhandledExceptionBus?: UnhandledExceptionBus,
    @Optional()
    @Inject(CQRS_MODULE_OPTIONS)
    private readonly options?: CqrsModuleOptions,
  ) {
    this.eventIdProvider =
      (options?.eventIdProvider as EventIdProvider<EventBase> | undefined) ??
      (defaultEventIdProvider as EventIdProvider<EventBase>);

    this.defaultPublisher = new DefaultPubSub<EventBase>(this.subject$);
    if (options?.eventPublisher) {
      this._publisher = options.eventPublisher as IEventPublisher<EventBase>;
    } else {
      this._publisher = this.defaultPublisher;
    }

    if (options?.onSagaError) {
      this.sagaErrorHandlers.add(options.onSagaError);
    }

    // Support external IMessageSource pushing directly into `this.subject$`
    this.bridgeListener = (event: EventBase) =>
      this.dispatchLocal(event, AsyncContext.of(event), false);
    this.bridgeUnsubscribe = this.subject$.subscribe(this.bridgeListener);
  }

  get publisher(): IEventPublisher<EventBase> {
    return this._publisher;
  }

  set publisher(publisher: IEventPublisher<EventBase>) {
    this._publisher = publisher;
  }

  bind(
    handler:
      InstanceWrapper<IEventHandler<EventBase>> | IEventHandler<EventBase>,
    id: string,
  ): void {
    let set = this.handlersById.get(id);
    if (!set) {
      set = new Set();
      this.handlersById.set(id, set);
    }
    const entry: StoredEventHandler<EventBase> = isInstanceWrapperLike(handler)
      ? {
          kind: "wrapper",
          wrapper: handler as InstanceWrapper<IEventHandler<EventBase>>,
        }
      : {
          kind: "instance",
          handler,
        };
    set.add(entry);
  }

  register<TEvent extends EventBase>(
    eventType: EventType<TEvent>,
    handler: IEventHandler<TEvent>,
  ): () => void;
  register(handlers?: InstanceWrapper<IEventHandler<EventBase>>[]): void;
  register(
    eventTypeOrHandlers?:
      EventType<any> | InstanceWrapper<IEventHandler<EventBase>>[],
    maybeHandler?: IEventHandler<any>,
  ): (() => void) | void {
    if (Array.isArray(eventTypeOrHandlers)) {
      for (const wrapper of eventTypeOrHandlers) {
        this.registerHandler(wrapper);
      }
      return;
    }

    if (!eventTypeOrHandlers) {
      return;
    }

    if (
      typeof eventTypeOrHandlers !== "function" ||
      !maybeHandler ||
      typeof maybeHandler.handle !== "function"
    ) {
      throw new InvalidEventsHandlerException();
    }

    let set = this.handlers.get(eventTypeOrHandlers);
    if (!set) {
      set = new Set();
      this.handlers.set(eventTypeOrHandlers, set);
    }
    const entry: StoredEventHandler<EventBase> = {
      kind: "instance",
      handler: maybeHandler as IEventHandler<EventBase>,
    };
    set.add(entry);

    const eventId = this.eventIdProvider.getEventId(
      eventTypeOrHandlers as Type<EventBase>,
    );
    let idSet: Set<StoredEventHandler<EventBase>> | undefined;
    if (eventId) {
      idSet = this.handlersById.get(eventId);
      if (!idSet) {
        idSet = new Set();
        this.handlersById.set(eventId, idSet);
      }
      idSet.add(entry);
    }

    return () => {
      set?.delete(entry);
      idSet?.delete(entry);
    };
  }

  protected registerHandler(
    wrapper: InstanceWrapper<IEventHandler<EventBase>>,
  ): void {
    const metatype =
      wrapper.metatype ??
      (wrapper.instance && typeof wrapper.instance === "object"
        ? wrapper.instance.constructor
        : undefined);
    if (typeof metatype !== "function") {
      throw new InvalidEventsHandlerException();
    }

    const eventTypes = MetadataRegistry.get<readonly EventType[]>(
      EVENTS_HANDLER_METADATA,
      metatype,
    );
    if (!eventTypes || eventTypes.length === 0) {
      throw new InvalidEventsHandlerException();
    }

    const proto = metatype.prototype as Record<string, unknown> | undefined;
    const hasHandle =
      typeof (wrapper.instance as Record<string, unknown> | undefined)
        ?.handle === "function" || typeof proto?.handle === "function";
    if (!hasHandle) {
      throw new InvalidEventsHandlerException();
    }

    const entry: StoredEventHandler<EventBase> =
      wrapper.isDependencyTreeStatic &&
      wrapper.scope === Scope.SINGLETON &&
      wrapper.instance
        ? {
            kind: "instance",
            handler: wrapper.instance as IEventHandler<EventBase>,
          }
        : {
            kind: "wrapper",
            wrapper,
          };

    for (const eventType of eventTypes) {
      let set = this.handlers.get(eventType);
      if (!set) {
        set = new Set();
        this.handlers.set(eventType, set);
      }
      set.add(entry);

      const id = this.eventIdProvider.getEventId(eventType as Type<EventBase>);
      if (id) {
        let idSet = this.handlersById.get(id);
        if (!idSet) {
          idSet = new Set();
          this.handlersById.set(id, idSet);
        }
        idSet.add(entry);
      }
    }
  }

  subscribe<TEvent extends EventBase = EventBase>(
    listenerOrObserver: StreamListener<TEvent>,
  ): SubscriptionHandle {
    const fn: EventSubscriber<EventBase> = isFunction(listenerOrObserver)
      ? (listenerOrObserver as EventSubscriber<EventBase>)
      : (e: EventBase) => listenerOrObserver.next?.(e as TEvent);

    this.subscribers.add(fn);
    let active = true;
    const unsub = (() => {
      if (!active) return;
      active = false;
      this.subscribers.delete(fn);
    }) as SubscriptionHandle;
    unsub.unsubscribe = unsub;
    return unsub;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<EventBase> {
    return this.subject$[Symbol.asyncIterator]();
  }

  registerSaga<TEvent extends EventBase = EventBase>(
    saga: ISaga<TEvent>,
    name?: string,
  ): () => void {
    if (typeof saga !== "function") {
      throw new InvalidSagaException();
    }
    const entry: SagaEntry<EventBase> = {
      fn: saga as ISaga<EventBase>,
      name: name ?? (saga.name || undefined),
      disabled: false,
      pausedUntil: 0,
      backoffMs: 100,
      lastErrorAt: 0,
    };
    this.sagas.add(entry);
    return () => {
      if (entry.resumeTimer !== undefined) {
        clearTimeout(entry.resumeTimer);
      }
      this.sagas.delete(entry);
    };
  }

  registerSagas(
    wrappers: readonly (InstanceWrapper<object> | ISaga<EventBase>)[] = [],
  ): void {
    for (const item of wrappers) {
      if (typeof item === "function") {
        this.registerSaga(item);
        continue;
      }

      if (!isInstanceWrapperLike(item)) {
        throw new InvalidSagaException();
      }

      if (!item.isDependencyTreeStatic || item.scope === Scope.REQUEST) {
        throw new UnsupportedSagaScopeException();
      }

      const instance = item.instance;
      const ctor =
        (instance && typeof instance === "object"
          ? (instance as { constructor?: Function }).constructor
          : undefined) ??
        (typeof item.metatype === "function" ? item.metatype : undefined);
      if (!instance || !ctor) {
        continue;
      }

      const sagaMetas = collectMergedClassArray<SagaMethodMetadata>(
        SAGA_METADATA,
        ctor,
      );
      for (const meta of sagaMetas) {
        const fn = (instance as Record<string | symbol, unknown>)[
          meta.methodName
        ];
        if (typeof fn !== "function") {
          throw new InvalidSagaException();
        }
        this.registerSaga(
          (event: EventBase) =>
            (fn as (e: EventBase) => Promise<SagaOutput> | SagaOutput).call(
              instance,
              event,
            ),
          String(meta.methodName),
        );
      }
    }
  }

  onSagaError(handler: SagaErrorHandler): () => void {
    this.sagaErrorHandlers.add(handler);
    return () => {
      this.sagaErrorHandlers.delete(handler);
    };
  }

  publish<TEvent extends EventBase>(event: TEvent): Promise<void> | any;
  publish<TEvent extends EventBase>(
    event: TEvent,
    asyncContext: AsyncContext,
  ): Promise<void> | any;
  publish<TEvent extends EventBase, TContext = unknown>(
    event: TEvent,
    dispatcherContext: TContext,
  ): Promise<void> | any;
  publish<TEvent extends EventBase, TContext = unknown>(
    event: TEvent,
    dispatcherContext: TContext,
    asyncContext: AsyncContext,
  ): Promise<void> | any;
  publish<TEvent extends EventBase>(
    event: TEvent,
    dispatcherContextOrAsyncContext?: unknown,
    maybeAsyncContext?: AsyncContext,
  ): Promise<void> | any {
    if (!event || typeof event !== "object") {
      return Promise.resolve();
    }

    const isSecondArgAsyncContext =
      dispatcherContextOrAsyncContext instanceof AsyncContext;
    const asyncContext = isSecondArgAsyncContext
      ? dispatcherContextOrAsyncContext
      : (maybeAsyncContext ?? AsyncContext.of(event));
    const dispatcherContext = isSecondArgAsyncContext
      ? undefined
      : dispatcherContextOrAsyncContext;

    if (asyncContext) {
      asyncContext.attachTo(event);
    }

    if (this._publisher !== this.defaultPublisher) {
      return this._publisher.publish(event, dispatcherContext, asyncContext);
    }

    return this.dispatchLocal(event, asyncContext, true);
  }

  publishAll<TEvent extends EventBase>(
    events: readonly TEvent[],
  ): Promise<void> | any;
  publishAll<TEvent extends EventBase>(
    events: readonly TEvent[],
    asyncContext: AsyncContext,
  ): Promise<void> | any;
  publishAll<TEvent extends EventBase, TContext = unknown>(
    events: readonly TEvent[],
    dispatcherContext: TContext,
  ): Promise<void> | any;
  publishAll<TEvent extends EventBase, TContext = unknown>(
    events: readonly TEvent[],
    dispatcherContext: TContext,
    asyncContext: AsyncContext,
  ): Promise<void> | any;
  publishAll<TEvent extends EventBase>(
    events: readonly TEvent[],
    dispatcherContextOrAsyncContext?: unknown,
    maybeAsyncContext?: AsyncContext,
  ): Promise<void> | any {
    const isSecondArgAsyncContext =
      dispatcherContextOrAsyncContext instanceof AsyncContext;
    const asyncContext = isSecondArgAsyncContext
      ? dispatcherContextOrAsyncContext
      : maybeAsyncContext;
    const dispatcherContext = isSecondArgAsyncContext
      ? undefined
      : dispatcherContextOrAsyncContext;

    if (
      this._publisher !== this.defaultPublisher &&
      typeof this._publisher.publishAll === "function"
    ) {
      if (asyncContext) {
        for (const event of events) {
          if (event && typeof event === "object") {
            asyncContext.attachTo(event);
          }
        }
      }
      return this._publisher.publishAll(
        events,
        dispatcherContext,
        asyncContext,
      );
    }

    if (this._publisher !== this.defaultPublisher) {
      return events.map((event) =>
        this.publishWithContext(event, dispatcherContext, asyncContext),
      );
    }

    return (async () => {
      for (const event of events) {
        await this.publishWithContext(event, dispatcherContext, asyncContext);
      }
    })();
  }

  private publishWithContext<TEvent extends EventBase>(
    event: TEvent,
    dispatcherContext: unknown,
    asyncContext: AsyncContext | undefined,
  ): Promise<void> | any {
    if (dispatcherContext !== undefined && asyncContext !== undefined) {
      return this.publish(event, dispatcherContext, asyncContext);
    }
    if (asyncContext !== undefined) {
      return this.publish(event, asyncContext);
    }
    if (dispatcherContext !== undefined) {
      return this.publish(event, dispatcherContext);
    }
    return this.publish(event);
  }

  async waitForSagas(): Promise<void> {
    while (this.inFlightSagas.size > 0) {
      await Promise.all([...this.inFlightSagas]);
    }
  }

  onModuleDestroy(): void {
    this.bridgeUnsubscribe();
    for (const entry of this.sagas) {
      if (entry.resumeTimer !== undefined) {
        clearTimeout(entry.resumeTimer);
      }
    }
    this.subject$.complete();
  }

  clear(): void {
    this.handlers.clear();
    this.handlersById.clear();
    this.subscribers.clear();
    for (const entry of this.sagas) {
      if (entry.resumeTimer !== undefined) {
        clearTimeout(entry.resumeTimer);
      }
    }
    this.sagas.clear();
    this.sagaErrorHandlers.clear();
    this.subject$.clear();
  }

  private async dispatchLocal(
    event: EventBase,
    asyncContext: AsyncContext | undefined,
    emitToSubject: boolean,
  ): Promise<void> {
    const ctor = event.constructor as Type<EventBase>;
    const matched = new Set<StoredEventHandler<EventBase>>();

    const byCtor = this.handlers.get(ctor);
    if (byCtor) {
      for (const h of byCtor) {
        matched.add(h);
      }
    }

    const eventId = this.eventIdProvider.getEventId(ctor);
    if (eventId) {
      const byId = this.handlersById.get(eventId);
      if (byId) {
        for (const h of byId) {
          matched.add(h);
        }
      }
    }

    const tasks: Array<Promise<void>> = [];
    const errors: unknown[] = [];

    for (const entry of matched) {
      tasks.push(
        Promise.resolve()
          .then(async () => {
            let handler: IEventHandler<EventBase>;
            if (entry.kind === "instance") {
              handler = entry.handler;
            } else {
              const ctx =
                asyncContext ?? AsyncContext.of(event) ?? new AsyncContext();
              ctx.attachTo(event);
              const ref = entry.wrapper.moduleRef ?? this.moduleRef;
              if (!ref) {
                throw new InvalidEventsHandlerException();
              }
              ref.registerRequestByContextId(ctx, ctx.id);
              handler = (await ref.resolve(entry.wrapper.token, ctx.id, {
                strict: false,
              })) as IEventHandler<EventBase>;
            }
            try {
              await handler.handle(event);
            } catch (err) {
              const handlerName =
                (handler as { constructor?: { name?: string } })?.constructor
                  ?.name ?? "EventHandler";
              if (this.options?.rethrowUnhandled === true) {
                this.publishUnhandledException(err, event);
                errors.push(err);
              } else {
                this.logger.error(
                  `"${handlerName}" has thrown an unhandled exception.`,
                  err,
                );
                this.publishUnhandledException(err, event);
              }
            }
          })
          .catch((err) => {
            this.publishUnhandledException(err, event);
            if (this.options?.rethrowUnhandled === true) {
              errors.push(err);
            }
          }),
      );
    }

    for (const subscriber of [...this.subscribers]) {
      tasks.push(
        Promise.resolve()
          .then(() => subscriber(event))
          .catch((err) => {
            this.publishUnhandledException(err, event);
            if (this.options?.rethrowUnhandled === true) {
              errors.push(err);
            }
          }),
      );
    }

    if (emitToSubject) {
      tasks.push(this.subject$.nextAsync(event, this.bridgeListener));
    }

    // Run sagas concurrently with isolated error capture (no unhandled rejections)
    const now = Date.now();
    for (const entry of [...this.sagas]) {
      if (
        entry.disabled ||
        (entry.pausedUntil > 0 && now < entry.pausedUntil)
      ) {
        continue;
      }
      const sagaTask = this.runSagaSafely(entry, event, errors);
      this.inFlightSagas.add(sagaTask);
      const tracked = sagaTask.finally(() => {
        this.inFlightSagas.delete(sagaTask);
      });
      tasks.push(tracked);
    }

    if (tasks.length > 0) {
      await Promise.all(tasks);
    }

    if (errors.length > 0) {
      throw errors[0];
    }
  }

  private async runSagaSafely(
    entry: SagaEntry<EventBase>,
    event: EventBase,
    rethrowBucket: unknown[],
  ): Promise<void> {
    try {
      const output: SagaOutput = await entry.fn(event);
      if (output === null || output === undefined) {
        return;
      }

      if (isAsyncIterable(output)) {
        for await (const cmd of output) {
          if (cmd && typeof cmd === "object") {
            await this.dispatchSagaCommand(cmd, event, rethrowBucket);
          }
        }
        return;
      }

      if (Array.isArray(output) || isCommandIterable(output)) {
        for (const cmd of output) {
          if (cmd && typeof cmd === "object") {
            await this.dispatchSagaCommand(cmd, event, rethrowBucket);
          }
        }
        return;
      }

      if (typeof output === "object") {
        await this.dispatchSagaCommand(output, event, rethrowBucket);
      }
    } catch (err) {
      this.handleSagaFailure(entry, err, event, rethrowBucket);
    }
  }

  private async dispatchSagaCommand(
    command: ICommand,
    sourceEvent: EventBase,
    rethrowBucket: unknown[],
  ): Promise<void> {
    try {
      AsyncContext.merge(sourceEvent, command);
      await this.commandBus.execute(command);
    } catch (err) {
      this.publishUnhandledException(err, command);
      this.reportSagaError(err, sourceEvent);
      if (this.options?.rethrowUnhandled === true) {
        rethrowBucket.push(err);
      }
    }
  }

  private handleSagaFailure(
    entry: SagaEntry<EventBase>,
    error: unknown,
    event: EventBase,
    rethrowBucket: unknown[],
  ): void {
    if (this.options?.rethrowUnhandled === true) {
      entry.disabled = true;
      rethrowBucket.push(error);
      return;
    }

    this.logger.error(
      `Saga "${entry.name ?? "anonymous"}" has thrown an unhandled exception.`,
      error,
    );
    const cause = (entry.name ?? event) as IEvent | ICommand;
    this.publishUnhandledException(error, cause);
    this.reportSagaError(error, event);

    const strategy = this.options?.sagaErrorStrategy ?? "complete";
    if (strategy === "complete") {
      entry.disabled = true;
    } else if (strategy === "resubscribe") {
      const now = Date.now();
      if (entry.lastErrorAt > 0 && now - entry.lastErrorAt >= 60_000) {
        entry.backoffMs = 100;
      }
      entry.lastErrorAt = now;
      const delay = entry.backoffMs;
      entry.pausedUntil = now + delay;
      entry.backoffMs = Math.min(30_000, entry.backoffMs * 2);
      if (entry.resumeTimer !== undefined) {
        clearTimeout(entry.resumeTimer);
      }
      entry.resumeTimer = setTimeout(() => {
        entry.pausedUntil = 0;
        entry.resumeTimer = undefined;
      }, delay);
      if (
        typeof (entry.resumeTimer as { unref?: () => void }).unref ===
        "function"
      ) {
        (entry.resumeTimer as { unref: () => void }).unref();
      }
    }
  }

  private publishUnhandledException(
    exception: unknown,
    cause: IEvent | ICommand,
  ): void {
    if (!this.unhandledExceptionBus) {
      return;
    }
    const info: UnhandledExceptionInfo<IEvent | ICommand> = {
      exception,
      cause,
    };
    try {
      void this.unhandledExceptionBus.publish(info);
    } catch {
      // Never allow unhandled-exception publisher failure to mask the original error
    }
  }

  private reportSagaError(error: unknown, event: IEvent): void {
    for (const handler of [...this.sagaErrorHandlers]) {
      try {
        handler(error, event);
      } catch {
        // Never allow error reporter to cause unhandled rejections
      }
    }
  }
}
