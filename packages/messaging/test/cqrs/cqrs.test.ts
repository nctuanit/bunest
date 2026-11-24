import { describe, expect, it } from "bun:test";
import { Injectable } from "@bunest/core";
import { Test } from "@bunest/testing";
import {
  AggregateRoot,
  CommandBus,
  CommandHandler,
  CommandHandlerNotFoundException,
  CqrsModule,
  DuplicateCommandHandlerException,
  DuplicateQueryHandlerException,
  EventBus,
  EventPublisher,
  EventsHandler,
  QueryBus,
  QueryHandler,
  QueryHandlerNotFoundException,
  Saga,
  type ICommand,
  type ICommandHandler,
  type IEvent,
  type IEventHandler,
  type IQuery,
  type IQueryHandler,
} from "../../src/cqrs/index";

class CreateOrderCommand implements ICommand {
  constructor(
    public readonly orderId: string,
    public readonly amount: number,
  ) {}
}

class SendReceiptCommand implements ICommand {
  constructor(public readonly orderId: string) {}
}

class GetOrderQuery implements IQuery {
  constructor(public readonly orderId: string) {}
}

class OrderCreatedEvent implements IEvent {
  constructor(
    public readonly orderId: string,
    public readonly amount: number,
  ) {}
}

class OrderAggregate extends AggregateRoot {
  public status = "draft";
  public amount = 0;

  constructor(public readonly id: string) {
    super();
  }

  place(amount: number): void {
    this.apply(new OrderCreatedEvent(this.id, amount));
  }

  onOrderCreatedEvent(event: OrderCreatedEvent): void {
    this.status = "placed";
    this.amount = event.amount;
  }
}

describe("../../src/cqrs/index", () => {
  it("dispatches commands & queries and fails fast on missing or duplicate handlers", async () => {
    const commandBus = new CommandBus();
    const queryBus = new QueryBus();

    await expect(
      commandBus.execute(new CreateOrderCommand("o1", 50)),
    ).rejects.toBeInstanceOf(CommandHandlerNotFoundException);

    await expect(
      queryBus.execute(new GetOrderQuery("o1")),
    ).rejects.toBeInstanceOf(QueryHandlerNotFoundException);

    const handler: ICommandHandler<CreateOrderCommand, string> = {
      execute: (cmd) => `created:${cmd.orderId}:${cmd.amount}`,
    };
    commandBus.register(CreateOrderCommand, handler);

    expect(() => commandBus.register(CreateOrderCommand, handler)).toThrow(
      DuplicateCommandHandlerException,
    );

    const qHandler: IQueryHandler<GetOrderQuery, { id: string }> = {
      execute: (q) => ({ id: q.orderId }),
    };
    queryBus.register(GetOrderQuery, qHandler);

    expect(() => queryBus.register(GetOrderQuery, qHandler)).toThrow(
      DuplicateQueryHandlerException,
    );

    expect(
      await commandBus.execute<string>(new CreateOrderCommand("o1", 99)),
    ).toBe("created:o1:99");
    expect(
      await queryBus.execute<{ id: string }>(new GetOrderQuery("o1")),
    ).toEqual({ id: "o1" });
  });

  it("supports multi-handler event fan-out, AggregateRoot + EventPublisher, and Sagas via CqrsModule", async () => {
    const ordersStore = new Map<
      string,
      { id: string; amount: number; receiptSent: boolean }
    >();
    const fanOutLog: string[] = [];
    const sagaErrors: unknown[] = [];

    @CommandHandler(CreateOrderCommand)
    class CreateOrderHandler implements ICommandHandler<
      CreateOrderCommand,
      string
    > {
      constructor(private readonly publisher: EventPublisher) {}

      async execute(command: CreateOrderCommand): Promise<string> {
        const agg = this.publisher.mergeObjectContext(
          new OrderAggregate(command.orderId),
        );
        agg.place(command.amount);
        expect(agg.status).toBe("placed");
        expect(agg.getUncommittedEvents()).toHaveLength(1);

        ordersStore.set(command.orderId, {
          id: command.orderId,
          amount: command.amount,
          receiptSent: false,
        });

        await agg.commit();
        expect(agg.getUncommittedEvents()).toHaveLength(0);
        return command.orderId;
      }
    }

    @CommandHandler(SendReceiptCommand)
    class SendReceiptHandler implements ICommandHandler<
      SendReceiptCommand,
      void
    > {
      execute(command: SendReceiptCommand): void {
        const order = ordersStore.get(command.orderId);
        if (order) {
          order.receiptSent = true;
        }
        fanOutLog.push(`receipt:${command.orderId}`);
      }
    }

    @QueryHandler(GetOrderQuery)
    class GetOrderHandler implements IQueryHandler<GetOrderQuery> {
      execute(query: GetOrderQuery) {
        return ordersStore.get(query.orderId) ?? null;
      }
    }

    @EventsHandler(OrderCreatedEvent)
    class AuditEventHandler implements IEventHandler<OrderCreatedEvent> {
      handle(event: OrderCreatedEvent): void {
        fanOutLog.push(`audit:${event.orderId}:${event.amount}`);
      }
    }

    @EventsHandler(OrderCreatedEvent)
    class AnalyticsEventHandler implements IEventHandler<OrderCreatedEvent> {
      async handle(event: OrderCreatedEvent): Promise<void> {
        await Bun.sleep(5);
        fanOutLog.push(`analytics:${event.orderId}`);
      }
    }

    @Injectable()
    class OrderSagas {
      @Saga()
      async onOrderCreated(event: IEvent) {
        if (event instanceof OrderCreatedEvent) {
          await Bun.sleep(5);
          return new SendReceiptCommand(event.orderId);
        }
        return undefined;
      }

      @Saga()
      async failingSaga(event: IEvent) {
        if (event instanceof OrderCreatedEvent && event.amount < 0) {
          throw new Error("invalid-saga-amount");
        }
        return undefined;
      }
    }

    const mod = await Test.createTestingModule({
      imports: [
        CqrsModule.forRoot({
          onSagaError: (err) => {
            sagaErrors.push(err);
          },
        }),
      ],
      providers: [
        CreateOrderHandler,
        SendReceiptHandler,
        GetOrderHandler,
        AuditEventHandler,
        AnalyticsEventHandler,
        OrderSagas,
      ],
    }).compile();

    await mod.init();

    const commandBus = mod.get(CommandBus);
    const queryBus = mod.get(QueryBus);
    const eventBus = mod.get(EventBus);

    const createdId = await commandBus.execute<string>(
      new CreateOrderCommand("ord_42", 199),
    );
    expect(createdId).toBe("ord_42");

    // Both event handlers + Saga follow-up command executed cleanly!
    expect(fanOutLog).toContain("audit:ord_42:199");
    expect(fanOutLog).toContain("analytics:ord_42");
    expect(fanOutLog).toContain("receipt:ord_42");

    const loaded = await queryBus.execute<{
      id: string;
      amount: number;
      receiptSent: boolean;
    }>(new GetOrderQuery("ord_42"));
    expect(loaded).toEqual({ id: "ord_42", amount: 199, receiptSent: true });

    // Saga throwing must be captured cleanly without unhandled rejection leak
    await eventBus.publish(new OrderCreatedEvent("ord_bad", -10));
    expect(sagaErrors).toHaveLength(1);
    expect((sagaErrors[0] as Error).message).toBe("invalid-saga-amount");

    // Async generator Saga yielding multiple follow-up commands
    const genUnreg = eventBus.registerSaga(async function* (event: IEvent) {
      if (event instanceof OrderCreatedEvent && event.orderId === "ord_gen") {
        await Bun.sleep(2);
        yield new SendReceiptCommand("ord_gen_1");
        yield new SendReceiptCommand("ord_gen_2");
      }
    });
    await eventBus.publish(new OrderCreatedEvent("ord_gen", 10));
    genUnreg();
    expect(fanOutLog).toContain("receipt:ord_gen_1");
    expect(fanOutLog).toContain("receipt:ord_gen_2");

    // AggregateRoot mergeClassContext, uncommit, and loadFromHistory
    const publisher = mod.get(EventPublisher);
    const ManagedOrder = publisher.mergeClassContext(OrderAggregate);
    const agg2 = new ManagedOrder("ord_99");
    agg2.loadFromHistory([new OrderCreatedEvent("ord_99", 500)]);
    expect(agg2.status).toBe("placed");
    expect(agg2.amount).toBe(500);
    expect(agg2.getUncommittedEvents()).toHaveLength(0);

    agg2.place(750);
    expect(agg2.getUncommittedEvents()).toHaveLength(1);
    agg2.uncommit();
    expect(agg2.getUncommittedEvents()).toHaveLength(0);

    await mod.close();
    // Cleanup cleared handlers on destroy
    expect(commandBus.hasHandler(CreateOrderCommand)).toBe(false);
    expect(queryBus.hasHandler(GetOrderQuery)).toBe(false);
  });

  it("mutates AggregateRoot state before autoCommit publishing and isolates sync throws in EventBus.publish()", async () => {
    const commandBus = new CommandBus();
    const eventBus = new EventBus(commandBus);
    const publisher = new EventPublisher(eventBus);

    // 1. autoCommit = true: subscriber MUST see updated state from onOrderCreatedEvent()
    const observedDuringAutoCommit: Array<{ status: string; amount: number }> =
      [];
    const agg = publisher.mergeObjectContext(new OrderAggregate("ord_auto"));
    agg.autoCommit = true;

    const unsub = eventBus.subscribe(() => {
      observedDuringAutoCommit.push({ status: agg.status, amount: agg.amount });
    });

    agg.place(100);
    await Bun.sleep(10);
    unsub();

    expect(observedDuringAutoCommit).toEqual([
      { status: "placed", amount: 100 },
    ]);

    // 2. Sync throw in event handler #1 must still dispatch event handler #2 cleanly
    const handledBySecond: string[] = [];
    eventBus.register(OrderCreatedEvent, {
      handle() {
        throw new Error("sync-handler-boom");
      },
    });
    eventBus.register(OrderCreatedEvent, {
      async handle(event) {
        await Bun.sleep(5);
        handledBySecond.push(event.orderId);
      },
    });

    await expect(
      eventBus.publish(new OrderCreatedEvent("ord_sync_err", 50)),
    ).rejects.toThrow("sync-handler-boom");

    await Bun.sleep(15);
    expect(handledBySecond).toEqual(["ord_sync_err"]);
  });
});
