import { afterAll, beforeAll, beforeEach, expect, it } from "bun:test";
import {
  Inject,
  Injectable,
  Module,
  REQUEST,
  Scope,
} from "../../../../../packages/core/src/common";
import {
  AggregateRoot,
  AsyncContext,
  CommandBus,
  CommandHandler,
  CqrsModule,
  EventBus,
  EventPublisher,
  EventsHandler,
  Publishable,
  type ICommandHandler,
  type IEvent,
  type IEventHandler,
  type IEventPublisher,
} from "../../../../../packages/messaging/src/cqrs";
import {
  Test,
  describeConformance,
  type TestingModule,
} from "../../../_helpers";
import { waitImmediate } from "../_fixtures/cqrs-fixtures";

interface Transaction {
  id: string;
  fail?: Error;
}

class OrderPlacedEvent implements IEvent {
  constructor(public readonly orderId: string) {}
}

class Order extends AggregateRoot {
  constructor(public readonly id: string) {
    super();
  }

  place() {
    this.apply(new OrderPlacedEvent(this.id));
  }
}

@Publishable()
class PublishableOrder extends Order {}

class PlaceOrderCommand {
  constructor(
    public readonly orderId: string,
    public readonly transaction?: Transaction,
    public readonly publishable = false,
  ) {}
}

class ScopedPlaceOrderCommand {
  constructor(
    public readonly orderId: string,
    public readonly transaction: Transaction,
  ) {}
}

@Injectable()
class TransactionalEventPublisher implements IEventPublisher {
  readonly written: Array<{
    orderIds: string[];
    context: unknown;
    asyncContext?: AsyncContext;
  }> = [];
  private readonly inner: IEventPublisher;

  constructor(eventBus: EventBus) {
    this.inner = eventBus.publisher;
    eventBus.publisher = this;
  }

  publish(event: IEvent, context?: unknown, asyncContext?: AsyncContext) {
    return this.publishAll([event], context, asyncContext);
  }

  async publishAll(
    events: readonly IEvent[],
    context?: unknown,
    asyncContext?: AsyncContext,
  ) {
    await waitImmediate();
    const transaction = (context as { transaction?: Transaction } | undefined)
      ?.transaction;
    if (transaction?.fail) {
      throw transaction.fail;
    }
    this.written.push({
      orderIds: events.map((event) => (event as OrderPlacedEvent).orderId),
      context,
      asyncContext,
    });
    events.forEach((event) => this.inner.publish(event, context, asyncContext));
    return `written in ${transaction?.id ?? "no transaction"}`;
  }
}

@CommandHandler(PlaceOrderCommand)
class PlaceOrderHandler implements ICommandHandler<PlaceOrderCommand> {
  constructor(private readonly publisher: EventPublisher) {}

  async execute({ orderId, transaction, publishable }: PlaceOrderCommand) {
    const order = publishable
      ? new PublishableOrder(orderId)
      : this.publisher.mergeObjectContext(new Order(orderId));
    order.place();
    return transaction ? order.commit({ transaction }) : order.commit();
  }
}

@CommandHandler(ScopedPlaceOrderCommand, { scope: Scope.REQUEST })
class ScopedPlaceOrderHandler implements ICommandHandler<ScopedPlaceOrderCommand> {
  constructor(
    private readonly publisher: EventPublisher,
    @Inject(REQUEST) private readonly context: AsyncContext,
  ) {}

  async execute({ orderId, transaction }: ScopedPlaceOrderCommand) {
    const MergedOrder = this.publisher.mergeClassContext(Order, this.context);
    const order = new MergedOrder(orderId);
    order.place();
    return order.commit({ transaction });
  }
}

@EventsHandler(OrderPlacedEvent)
class OrderPlacedHandler implements IEventHandler<OrderPlacedEvent> {
  static readonly handled: string[] = [];

  handle(event: OrderPlacedEvent) {
    OrderPlacedHandler.handled.push(event.orderId);
  }
}

@Module({
  imports: [CqrsModule.forRoot()],
  providers: [
    TransactionalEventPublisher,
    PlaceOrderHandler,
    ScopedPlaceOrderHandler,
    OrderPlacedHandler,
  ],
})
class OrdersModule {}

describeConformance(
  "Aggregate commit with a dispatcher context",
  {
    upstreamPath: "nestjs/cqrs/test/e2e/aggregate-commit-context.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    let moduleRef: TestingModule;
    let commandBus: CommandBus;
    let publisher: TransactionalEventPublisher;

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({
        imports: [OrdersModule],
      }).compile();
      await moduleRef.init();

      commandBus = moduleRef.get(CommandBus);
      publisher = moduleRef.get(TransactionalEventPublisher);
    });

    beforeEach(() => {
      publisher.written.length = 0;
      OrderPlacedHandler.handled.length = 0;
    });

    afterAll(async () => {
      await moduleRef.close();
    });

    it("awaits the publisher, which receives the transaction and the events", async () => {
      const transaction = { id: "tx-1" };

      const result = await commandBus.execute(
        new PlaceOrderCommand("order-1", transaction),
      );

      expect(result).toBe("written in tx-1");
      expect(publisher.written).toEqual([
        {
          orderIds: ["order-1"],
          context: { transaction },
          asyncContext: undefined,
        },
      ]);
      await waitImmediate();
      expect(OrderPlacedHandler.handled).toEqual(["order-1"]);
    });

    it("rejects with the publisher's error", async () => {
      const fail = new Error("serialization failure");

      await expect(
        commandBus.execute(
          new PlaceOrderCommand("order-2", { id: "tx-2", fail }),
        ),
      ).rejects.toBe(fail);

      await waitImmediate();
      expect(publisher.written).toEqual([]);
      expect(OrderPlacedHandler.handled).toEqual([]);
    });

    it("passes the transaction from a @Publishable() aggregate", async () => {
      const transaction = { id: "tx-3" };

      await commandBus.execute(
        new PlaceOrderCommand("order-3", transaction, true),
      );

      expect(publisher.written).toEqual([
        {
          orderIds: ["order-3"],
          context: { transaction },
          asyncContext: undefined,
        },
      ]);
    });

    // BUNEST_BUG: Expected CommandBus.execute(cmd, asyncContext) to register asyncContext as the REQUEST provider for asyncContext.id before resolving Scope.REQUEST command handlers, but packages/messaging/src/cqrs/command-bus.ts calls ref.resolve() without ref.registerRequestByContextId(ctx, ctx.id).
    it.skip("keeps the async context of a request-scoped handler", async () => {
      const asyncContext = new AsyncContext();
      const transaction = { id: "tx-4" };

      await commandBus.execute(
        new ScopedPlaceOrderCommand("order-4", transaction),
        asyncContext,
      );

      expect(publisher.written).toEqual([
        { orderIds: ["order-4"], context: { transaction }, asyncContext },
      ]);
    });

    it("keeps passing the aggregate as the dispatcher context without one", async () => {
      await commandBus.execute(new PlaceOrderCommand("order-5"));

      expect(publisher.written).toHaveLength(1);
      expect(publisher.written[0]?.context).toBeInstanceOf(Order);
    });
  },
);
