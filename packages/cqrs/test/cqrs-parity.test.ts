import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { Injectable, Module, Scope } from "@bunest/common";
import { Test } from "@bunest/testing";
import {
  ASYNC_CONTEXT_ATTRIBUTE,
  AggregateRoot,
  AsyncContext,
  Command,
  CommandBus,
  CommandHandler,
  CqrsModule,
  DefaultCommandPubSub,
  DefaultPubSub,
  DefaultQueryPubSub,
  DefaultUnhandledExceptionPubSub,
  EventBus,
  EventPublisher,
  EventsHandler,
  InvalidCommandHandlerException,
  InvalidEventsHandlerException,
  InvalidQueryHandlerException,
  InvalidSagaException,
  Publishable,
  Query,
  QueryBus,
  QueryHandler,
  Saga,
  SubscribableStream,
  UnhandledExceptionBus,
  UnsupportedSagaScopeException,
  WithAggregateRoot,
  defaultEventIdProvider,
  type CommandResult,
  type CqrsModuleOptions,
  type CqrsModuleOptionsFactory,
  type ICommand,
  type ICommandHandler,
  type ICommandPublisher,
  type IEvent,
  type IEventHandler,
  type IEventPublisher,
  type IMessageSource,
  type IQuery,
  type IQueryHandler,
  type IQueryPublisher,
  type QueryResult,
  type SubjectLike,
  type UnhandledExceptionInfo,
} from "../src/index";

class CreateInvoiceCommand extends Command<{ invoiceId: string; total: number }> {
  constructor(
    public readonly customerId: string,
    public readonly total: number,
  ) {
    super();
  }
}

class GetInvoiceQuery extends Query<{ invoiceId: string; paid: boolean }> {
  constructor(public readonly invoiceId: string) {
    super();
  }
}

class InvoiceIssuedEvent implements IEvent {
  constructor(
    public readonly invoiceId: string,
    public readonly amount: number,
  ) {}
}

class InvoiceCancelledEvent implements IEvent {
  constructor(public readonly invoiceId: string) {}
}

class CustomDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomDomainError";
  }
}

class BaseEntity {
  public readonly createdAt = 12345;
  constructor(public readonly id: string) {}
}

@Publishable()
class PublishableInvoice extends WithAggregateRoot(BaseEntity) {
  public amount = 0;

  issue(amount: number): void {
    this.apply(new InvoiceIssuedEvent(this.id, amount));
  }

  onInvoiceIssuedEvent(event: InvoiceIssuedEvent): void {
    this.amount = event.amount;
  }
}

describe("@bunest/cqrs — NestJS @nestjs/cqrs v12 Parity", () => {
  it("infers return types automatically for typed Command<T> & Query<T> classes", async () => {
    // Compile-time type checks for CommandResult & QueryResult
    const _cmdCheck: CommandResult<CreateInvoiceCommand> = {
      invoiceId: "inv_1",
      total: 100,
    };
    const _qryCheck: QueryResult<GetInvoiceQuery> = {
      invoiceId: "inv_1",
      paid: true,
    };
    expect(_cmdCheck.invoiceId).toBe("inv_1");
    expect(_qryCheck.paid).toBe(true);

    @CommandHandler(CreateInvoiceCommand)
    class CreateInvoiceHandler implements ICommandHandler<CreateInvoiceCommand> {
      async execute(command: CreateInvoiceCommand) {
        return {
          invoiceId: `inv_${command.customerId}`,
          total: command.total,
        };
      }
    }

    @QueryHandler(GetInvoiceQuery)
    class GetInvoiceHandler implements IQueryHandler<GetInvoiceQuery> {
      async execute(query: GetInvoiceQuery) {
        return {
          invoiceId: query.invoiceId,
          paid: true,
        };
      }
    }

    const mod = await Test.createTestingModule({
      imports: [CqrsModule.forRoot()],
      providers: [CreateInvoiceHandler, GetInvoiceHandler],
    }).compile();

    await mod.init();

    const commandBus = mod.get(CommandBus);
    const queryBus = mod.get(QueryBus);

    // Zero manual generic type params needed!
    const created = await commandBus.execute(
      new CreateInvoiceCommand("cust_7", 250),
    );
    expect(created.invoiceId).toBe("inv_cust_7");
    expect(created.total).toBe(250);

    const queried = await queryBus.execute(new GetInvoiceQuery("inv_cust_7"));
    expect(queried.invoiceId).toBe("inv_cust_7");
    expect(queried.paid).toBe(true);

    await mod.close();
  });

  it("supports AsyncContext attachment, merging, and Scope.REQUEST command/query/event handlers", async () => {
    const ctx1 = new AsyncContext();
    const ctx2 = new AsyncContext();
    expect(ctx1.id).not.toEqual(ctx2.id);

    const objA = {};
    const objB = {};
    expect(AsyncContext.isAttached(objA)).toBe(false);
    ctx1.attachTo(objA);
    expect(AsyncContext.isAttached(objA)).toBe(true);
    expect(AsyncContext.of(objA)).toBe(ctx1);
    expect((objA as Record<symbol, unknown>)[ASYNC_CONTEXT_ATTRIBUTE]).toBe(ctx1);

    AsyncContext.merge(objA, objB);
    expect(AsyncContext.of(objB)).toBe(ctx1);

    const objC = {};
    AsyncContext.merge(ctx2, objC);
    expect(AsyncContext.of(objC)).toBe(ctx2);

    const cmdInstances = new Set<object>();
    const qryInstances = new Set<object>();
    const evtInstances = new Set<object>();
    const observedCtxIds: unknown[] = [];

    @CommandHandler(CreateInvoiceCommand, { scope: Scope.REQUEST })
    class ScopedCreateHandler implements ICommandHandler<CreateInvoiceCommand> {
      async execute(command: CreateInvoiceCommand) {
        cmdInstances.add(this);
        observedCtxIds.push(AsyncContext.of(command)?.id);
        return { invoiceId: `scoped_${command.customerId}`, total: command.total };
      }
    }

    @QueryHandler(GetInvoiceQuery, { scope: Scope.REQUEST })
    class ScopedGetHandler implements IQueryHandler<GetInvoiceQuery> {
      async execute(query: GetInvoiceQuery) {
        qryInstances.add(this);
        return { invoiceId: query.invoiceId, paid: false };
      }
    }

    @EventsHandler(InvoiceIssuedEvent, { scope: Scope.REQUEST })
    class ScopedEventHandler implements IEventHandler<InvoiceIssuedEvent> {
      handle(event: InvoiceIssuedEvent): void {
        evtInstances.add(this);
        observedCtxIds.push(AsyncContext.of(event)?.id);
      }
    }

    const mod = await Test.createTestingModule({
      imports: [CqrsModule.forRoot()],
      providers: [ScopedCreateHandler, ScopedGetHandler, ScopedEventHandler],
    }).compile();

    await mod.init();

    const commandBus = mod.get(CommandBus);
    const queryBus = mod.get(QueryBus);
    const eventBus = mod.get(EventBus);

    await commandBus.execute(new CreateInvoiceCommand("a", 10), ctx1);
    await commandBus.execute(new CreateInvoiceCommand("b", 20), ctx2);
    expect(cmdInstances.size).toBe(2);

    await queryBus.execute(new GetInvoiceQuery("1"), ctx1);
    await queryBus.execute(new GetInvoiceQuery("2"), ctx2);
    expect(qryInstances.size).toBe(2);

    await eventBus.publish(new InvoiceIssuedEvent("inv1", 10), ctx1);
    await eventBus.publish(new InvoiceIssuedEvent("inv2", 20), ctx2);
    expect(evtInstances.size).toBe(2);
    expect(observedCtxIds).toContain(ctx1.id);
    expect(observedCtxIds).toContain(ctx2.id);

    await mod.close();
  });

  it("supports WithAggregateRoot mixin and @Publishable() auto-binding on bootstrap", async () => {
    const received: InvoiceIssuedEvent[] = [];

    @EventsHandler(InvoiceIssuedEvent)
    class InvoiceIssuedHandler implements IEventHandler<InvoiceIssuedEvent> {
      handle(event: InvoiceIssuedEvent): void {
        received.push(event);
      }
    }

    const mod = await Test.createTestingModule({
      imports: [CqrsModule.forRoot()],
      providers: [InvoiceIssuedHandler],
    }).compile();

    await mod.init();

    // No manual eventPublisher.mergeObjectContext() needed thanks to @Publishable()!
    const invoice = new PublishableInvoice("inv_pub_1");
    expect(invoice.id).toBe("inv_pub_1");
    expect(invoice.createdAt).toBe(12345);

    invoice.issue(499);
    expect(invoice.amount).toBe(499);
    expect(invoice.getUncommittedEvents()).toHaveLength(1);

    await invoice.commit();
    expect(invoice.getUncommittedEvents()).toHaveLength(0);
    expect(received).toHaveLength(1);
    expect(received[0]!.invoiceId).toBe("inv_pub_1");
    expect(received[0]!.amount).toBe(499);

    // Boolean isFromHistory shorthand + skipHandler option on mixin
    invoice.apply(new InvoiceIssuedEvent("inv_pub_1", 999), true);
    expect(invoice.amount).toBe(999);
    expect(invoice.getUncommittedEvents()).toHaveLength(0);

    invoice.apply(new InvoiceIssuedEvent("inv_pub_1", 1), {
      skipHandler: true,
    });
    expect(invoice.amount).toBe(999);
    expect(invoice.getUncommittedEvents()).toHaveLength(1);
    invoice.uncommit();
    expect(invoice.getUncommittedEvents()).toHaveLength(0);

    await mod.close();
  });

  it("supports UnhandledExceptionBus (subscribe, AsyncIterable, ofType), rethrowUnhandled, and sagaErrorStrategy", async () => {
    const caughtInfos: UnhandledExceptionInfo[] = [];
    const filteredDomainErrors: UnhandledExceptionInfo[] = [];
    let sagaRunCount = 0;

    @EventsHandler(InvoiceIssuedEvent)
    class ThrowingEventHandler implements IEventHandler<InvoiceIssuedEvent> {
      handle(event: InvoiceIssuedEvent): void {
        if (event.amount < 0) {
          throw new CustomDomainError(`negative:${event.invoiceId}`);
        }
      }
    }

    @Injectable()
    class InvoiceSagas {
      @Saga()
      onCancelled = (event: IEvent) => {
        if (event instanceof InvoiceCancelledEvent) {
          sagaRunCount++;
          throw new CustomDomainError(`saga-boom:${event.invoiceId}`);
        }
        return undefined;
      };
    }

    const mod = await Test.createTestingModule({
      imports: [
        CqrsModule.forRoot({
          rethrowUnhandled: false,
          sagaErrorStrategy: "complete",
        }),
      ],
      providers: [ThrowingEventHandler, InvoiceSagas],
    }).compile();

    await mod.init();

    const eventBus = mod.get(EventBus);
    const exceptionBus = mod.get<UnhandledExceptionBus>(UnhandledExceptionBus);

    const sub = exceptionBus.subscribe((info) => {
      caughtInfos.push(info);
    });

    const domainOnly = UnhandledExceptionBus.ofType(CustomDomainError)(
      exceptionBus,
    );
    const filteredSub = domainOnly.subscribe((info) => {
      filteredDomainErrors.push(info);
    });

    // Also test native AsyncIterable consumption!
    const iterated: UnhandledExceptionInfo[] = [];
    const iter = exceptionBus[Symbol.asyncIterator]();
    const nextItemPromise = iter.next();

    // 1. Event handler throws -> captured by UnhandledExceptionBus without rejecting publish()!
    await eventBus.publish(new InvoiceIssuedEvent("inv_neg", -5));
    const firstIter = await nextItemPromise;
    expect(firstIter.done).toBe(false);
    iterated.push(firstIter.value);
    await iter.return?.();

    expect(caughtInfos).toHaveLength(1);
    expect(caughtInfos[0]!.exception).toBeInstanceOf(CustomDomainError);
    expect((caughtInfos[0]!.cause as InvoiceIssuedEvent).invoiceId).toBe(
      "inv_neg",
    );
    expect(filteredDomainErrors).toHaveLength(1);
    expect(iterated).toHaveLength(1);

    // 2. Property @Saga throws -> captured once and disabled due to sagaErrorStrategy: "complete"
    await eventBus.publish(new InvoiceCancelledEvent("inv_c1"));
    await eventBus.publish(new InvoiceCancelledEvent("inv_c2"));
    expect(sagaRunCount).toBe(1);
    expect(caughtInfos).toHaveLength(2);

    sub.unsubscribe();
    filteredSub.unsubscribe();
    await mod.close();
  });

  it("supports CqrsModule.forRootAsync (useValue, useFactory, useClass, useExisting) and pluggable publishers", async () => {
    const publishedCommands: ICommand[] = [];
    const publishedQueries: unknown[] = [];
    const publishedEvents: Array<{ event: IEvent; ctx: unknown }> = [];
    const publishedUnhandled: UnhandledExceptionInfo[] = [];

    const customCommandPublisher: ICommandPublisher = {
      publish(cmd) {
        publishedCommands.push(cmd);
      },
    };
    const customQueryPublisher: IQueryPublisher = {
      publish(q) {
        publishedQueries.push(q);
      },
    };
    const customEventPublisher: IEventPublisher = {
      publish(event, dispatcherContext) {
        publishedEvents.push({ event, ctx: dispatcherContext });
      },
    };

    @Injectable()
    class CqrsConfigFactory implements CqrsModuleOptionsFactory {
      createCqrsOptions(): CqrsModuleOptions {
        return {
          commandPublisher: customCommandPublisher,
          queryPublisher: customQueryPublisher,
          eventPublisher: customEventPublisher,
          unhandledExceptionPublisher: {
            publish(info) {
              publishedUnhandled.push(info);
            },
          },
        };
      }
    }

    @CommandHandler(CreateInvoiceCommand)
    class CmdHandler implements ICommandHandler<CreateInvoiceCommand> {
      execute(command: CreateInvoiceCommand) {
        return { invoiceId: command.customerId, total: command.total };
      }
    }

    @QueryHandler(GetInvoiceQuery)
    class QryHandler implements IQueryHandler<GetInvoiceQuery> {
      execute(query: GetInvoiceQuery) {
        return { invoiceId: query.invoiceId, paid: true };
      }
    }

    // 1. useClass
    const modClass = await Test.createTestingModule({
      imports: [CqrsModule.forRootAsync({ useClass: CqrsConfigFactory })],
      providers: [CmdHandler, QryHandler],
    }).compile();
    await modClass.init();

    const cmdBus = modClass.get(CommandBus);
    const qryBus = modClass.get(QueryBus);
    const evtBus = modClass.get(EventBus);
    const errBus = modClass.get(UnhandledExceptionBus);
    const eventPublisher = modClass.get(EventPublisher);

    expect(cmdBus.publisher).toBe(customCommandPublisher);
    expect(qryBus.publisher).toBe(customQueryPublisher);
    expect(evtBus.publisher).toBe(customEventPublisher);

    await cmdBus.execute(new CreateInvoiceCommand("c1", 50));
    await qryBus.execute(new GetInvoiceQuery("i1"));

    // EventPublisher passes aggregate (or explicit dispatcherContext) to custom IEventPublisher!
    class SimpleAgg extends AggregateRoot {
      fire() {
        this.apply(new InvoiceIssuedEvent("i1", 50));
      }
    }
    const agg = eventPublisher.mergeObjectContext(new SimpleAgg());
    agg.fire();
    await agg.commit({ tx: "tx-1" });

    errBus.publish({ exception: new Error("manual"), cause: new InvoiceIssuedEvent("i1", 1) });

    expect(publishedCommands).toHaveLength(1);
    expect(publishedQueries).toHaveLength(1);
    expect(publishedEvents).toHaveLength(1);
    expect(publishedEvents[0]!.ctx).toEqual({ tx: "tx-1" });
    expect(publishedUnhandled).toHaveLength(1);

    await modClass.close();

    // 2. useExisting
    @Module({
      providers: [CqrsConfigFactory],
      exports: [CqrsConfigFactory],
    })
    class ExistingConfigModule {}

    const modExisting = await Test.createTestingModule({
      imports: [
        CqrsModule.forRootAsync({
          imports: [ExistingConfigModule],
          useExisting: CqrsConfigFactory,
        }),
      ],
    }).compile();
    await modExisting.init();
    expect(modExisting.get(CommandBus).publisher).toBe(customCommandPublisher);
    await modExisting.close();

    // 3. useFactory & useValue
    const modFactory = await Test.createTestingModule({
      imports: [
        CqrsModule.forRootAsync({
          useFactory: () => ({ rethrowUnhandled: false }),
        }),
      ],
    }).compile();
    await modFactory.init();
    await modFactory.close();

    const modValue = await Test.createTestingModule({
      imports: [
        CqrsModule.forRootAsync({
          useValue: { rethrowUnhandled: false },
        }),
      ],
    }).compile();
    await modValue.init();
    await modValue.close();

    expect(() => CqrsModule.forRootAsync({})).toThrow(/Invalid CqrsModuleAsyncOptions/);
  });

  it("supports Default*PubSub helpers, IMessageSource bridging, bus streams, and custom EventIdProvider", async () => {
    const cmdStream = new SubscribableStream<ICommand>();
    const qryStream = new SubscribableStream<IQuery>();
    const evtStream = new SubscribableStream<IEvent>();
    const errStream = new SubscribableStream<UnhandledExceptionInfo>();

    const seenCmds: ICommand[] = [];
    const seenQrys: unknown[] = [];
    const seenEvts: IEvent[] = [];
    const seenErrs: UnhandledExceptionInfo[] = [];

    cmdStream.subscribe((c) => { seenCmds.push(c); });
    qryStream.subscribe((q) => { seenQrys.push(q); });
    evtStream.subscribe((e) => { seenEvts.push(e); });
    errStream.subscribe((e) => { seenErrs.push(e); });

    new DefaultCommandPubSub(cmdStream).publish(new CreateInvoiceCommand("x", 1));
    new DefaultQueryPubSub(qryStream).publish(new GetInvoiceQuery("x"));
    const defaultEvtPub = new DefaultPubSub(evtStream);
    defaultEvtPub.publish(new InvoiceIssuedEvent("x", 1));
    new DefaultUnhandledExceptionPubSub(errStream).publish({
      exception: new Error("e"),
      cause: new InvoiceIssuedEvent("x", 1),
    });

    expect(seenCmds).toHaveLength(1);
    expect(seenQrys).toHaveLength(1);
    expect(seenEvts).toHaveLength(1);
    expect(seenErrs).toHaveLength(1);

    // IMessageSource bridging into EventBus.subject$
    const commandBus = new CommandBus();
    const eventBus = new EventBus(commandBus);
    const handledFromBridge: string[] = [];

    eventBus.register(InvoiceIssuedEvent, {
      handle(ev) {
        handledFromBridge.push(ev.invoiceId);
      },
    });

    class ExternalSource implements IMessageSource<IEvent> {
      private target?: SubjectLike<IEvent>;
      bridgeEventsTo<T extends IEvent>(subject: SubjectLike<T>): void {
        this.target = subject as unknown as SubjectLike<IEvent>;
      }
      emitExternal(event: IEvent): void {
        this.target?.next(event);
      }
    }

    const source = new ExternalSource();
    source.bridgeEventsTo(eventBus.subject$);
    source.emitExternal(new InvoiceIssuedEvent("from-bridge", 42));
    await Bun.sleep(10);

    expect(handledFromBridge).toEqual(["from-bridge"]);
    expect(defaultEventIdProvider.getEventId(InvoiceIssuedEvent)).toBeTruthy();

    // Direct bus subscriptions on CommandBus & QueryBus
    const queryBus = new QueryBus();
    const busCmds: ICommand[] = [];
    const busQrys: unknown[] = [];
    const unsubCmd = commandBus.subscribe((c) => { busCmds.push(c); });
    const unsubQry = queryBus.subscribe((q) => { busQrys.push(q); });

    commandBus.register(CreateInvoiceCommand, {
      execute: (c) => ({ invoiceId: c.customerId, total: c.total }),
    });
    queryBus.register(GetInvoiceQuery, {
      execute: (q) => ({ invoiceId: q.invoiceId, paid: true }),
    });

    await commandBus.execute(new CreateInvoiceCommand("stream-c", 5));
    await queryBus.execute(new GetInvoiceQuery("stream-q"));

    expect(busCmds).toHaveLength(1);
    expect(busQrys).toHaveLength(1);

    unsubCmd();
    unsubQry();
    eventBus.onModuleDestroy();
  });

  it("throws all 5 Invalid*/UnsupportedSagaScope exceptions on invalid registrations", async () => {
    const commandBus = new CommandBus();
    const queryBus = new QueryBus();
    const eventBus = new EventBus(commandBus);

    expect(() =>
      commandBus.register(CreateInvoiceCommand, {} as any),
    ).toThrow(InvalidCommandHandlerException);

    expect(() =>
      queryBus.register(GetInvoiceQuery, {} as any),
    ).toThrow(InvalidQueryHandlerException);

    expect(() =>
      eventBus.register(InvoiceIssuedEvent, {} as any),
    ).toThrow(InvalidEventsHandlerException);

    expect(() => eventBus.registerSaga("not-a-fn" as any)).toThrow(
      InvalidSagaException,
    );

    // Request-scoped saga host MUST throw UnsupportedSagaScopeException on bootstrap!
    @Injectable({ scope: Scope.REQUEST })
    class RequestScopedSagaHost {
      @Saga()
      onEvent() {
        return undefined;
      }
    }

    const mod = await Test.createTestingModule({
      imports: [CqrsModule.forRoot()],
      providers: [RequestScopedSagaHost],
    }).compile();

    await expect(mod.init()).rejects.toBeInstanceOf(
      UnsupportedSagaScopeException,
    );

    await mod.close();
  });
});
