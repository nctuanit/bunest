import "reflect-metadata";
import { Body, Controller, Get, Injectable, Module, Param, Post } from "@bunest/common";
import {
  CommandBus,
  CommandHandler,
  CqrsModule,
  type ICommand,
  type ICommandHandler,
} from "@bunest/cqrs";
import { EmitEvent, EventEmitterModule, OnEvent } from "@bunest/events";
import {
  InMemorySpanExporter,
  ObservabilityModule,
  Span,
  extractTraceContext,
  injectTraceContext,
  traceContextStorage,
} from "@bunest/observability";
import {
  InjectQueue,
  MemoryQueueDriver,
  Process,
  Processor,
  Queue,
  QueueModule,
  type Job,
} from "@bunest/queues";
import {
  JpaRepository,
  Modifying,
  Query,
  SqlParam,
  SqliteModule,
  SqliteRepository,
  type SqliteMigration,
} from "@bunest/sqlite";

export interface OrderRecord {
  readonly id: number;
  readonly item: string;
  readonly amount: number;
  readonly status: string;
}

export interface ProcessOrderJobData {
  readonly orderId: number;
  readonly failOnce?: boolean;
  readonly traceHeaders: Record<string, string>;
}

export class CreateOrderCommand implements ICommand {
  constructor(
    public readonly item: string,
    public readonly amount: number,
    public readonly failOnce: boolean = false,
  ) {}
}

export const ORDER_MIGRATIONS: readonly SqliteMigration[] = [
  {
    id: "001_create_orders",
    up: `
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item TEXT NOT NULL,
        amount INTEGER NOT NULL,
        status TEXT NOT NULL
      );
    `,
    down: "DROP TABLE orders;",
  },
];

@SqliteRepository({ table: "orders", camelCaseMapping: false })
export abstract class OrderRepository extends JpaRepository<OrderRecord, number> {
  @Modifying()
  @Query("UPDATE orders SET status = :status WHERE id = :id")
  updateStatus(
    @SqlParam("id") _id: number,
    @SqlParam("status") _status: string,
  ): Promise<number> {
    return 0 as unknown as Promise<number>;
  }
}

@CommandHandler(CreateOrderCommand)
export class CreateOrderHandler
  implements ICommandHandler<CreateOrderCommand, OrderRecord>
{
  constructor(
    private readonly orders: OrderRepository,
    @InjectQueue("orders")
    private readonly ordersQueue: Queue<ProcessOrderJobData, { orderId: number }>,
  ) {}

  async execute(command: CreateOrderCommand): Promise<OrderRecord> {
    // Child DB span linked automatically to active HTTP span via @Span()
    const order = await this.insertOrder(command);

    // Propagate W3C traceparent into the background queue job payload
    const traceHeaders: Record<string, string> = {};
    injectTraceContext(traceHeaders);

    await this.ordersQueue.add(
      "process-order",
      {
        orderId: order.id,
        failOnce: command.failOnce,
        traceHeaders,
      },
      {
        attempts: 3,
        backoff: { type: "fixed", delayMs: 15 },
      },
    );

    return order;
  }

  @Span("db.insert_order", {
    kind: "CLIENT",
    attributes: (command: CreateOrderCommand) => ({
      "db.system": "sqlite",
      "db.operation": "INSERT",
      "order.item": command.item,
    }),
  })
  insertOrder(command: CreateOrderCommand): Promise<OrderRecord> {
    return this.orders.save({
      item: command.item,
      amount: command.amount,
      status: "pending",
    });
  }
}

@Processor("orders", { concurrency: 2 })
export class OrdersProcessor {
  private readonly failedOnceIds = new Set<number>();

  constructor(private readonly orders: OrderRepository) {}

  @Process("process-order")
  async handleProcessOrder(
    job: Job<ProcessOrderJobData, { orderId: number }>,
  ): Promise<{ orderId: number }> {
    const parentContext = extractTraceContext(job.data.traceHeaders);
    if (parentContext) {
      return traceContextStorage.run(parentContext, () =>
        this.processOrder(job),
      );
    }
    return this.processOrder(job);
  }

  @Span("queue.process_order", {
    kind: "CONSUMER",
    attributes: (job: Job<ProcessOrderJobData, { orderId: number }>) => ({
      "messaging.system": "bunest.queues",
      "messaging.destination": "orders",
      "order.id": job.data.orderId,
      "order.attempt": job.attemptsMade + 1,
    }),
  })
  @EmitEvent("order.processed", { async: true })
  async processOrder(
    job: Job<ProcessOrderJobData, { orderId: number }>,
  ): Promise<{ orderId: number }> {
    if (job.data.failOnce && !this.failedOnceIds.has(job.data.orderId)) {
      this.failedOnceIds.add(job.data.orderId);
      throw new Error(
        `Transient payment gateway timeout for order ${job.data.orderId}`,
      );
    }

    await this.orders.updateStatus(job.data.orderId, "processed");
    return { orderId: job.data.orderId };
  }
}

@Injectable()
export class OrderEventAuditListener {
  public readonly processedOrders: number[] = [];

  @OnEvent("order.processed")
  onOrderProcessed(payload: { orderId: number }): void {
    this.processedOrders.push(payload.orderId);
  }
}

@Controller("/orders")
export class OrdersController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly orders: OrderRepository,
  ) {}

  @Post()
  async create(
    @Body() body: { item: string; amount: number; failOnce?: boolean },
  ): Promise<OrderRecord> {
    return this.commandBus.execute<OrderRecord>(
      new CreateOrderCommand(body.item, body.amount, body.failOnce ?? false),
    );
  }

  @Get(":id")
  findOne(@Param("id") id: string): Promise<OrderRecord | null> {
    return this.orders.findById(Number(id));
  }
}

export function createDistributedWorkerModule(
  exporter: InMemorySpanExporter = new InMemorySpanExporter(),
) {
  @Module({
    imports: [
      ObservabilityModule.forRoot({
        tracing: {
          serviceName: "bunest-distributed-worker",
          exporter,
          registerGlobalInterceptor: true,
          global: true,
        },
        metrics: {
          path: "/metrics",
          registerGlobalInterceptor: true,
          global: true,
        },
        health: {
          livenessPath: "/health",
          readinessPath: "/ready",
          global: true,
        },
      }),
      SqliteModule.forRoot({
        filename: ":memory:",
        migrations: ORDER_MIGRATIONS,
        autoMigrate: true,
        global: true,
      }),
      SqliteModule.forFeature([OrderRepository]),
      EventEmitterModule.forRoot({ global: true }),
      CqrsModule.forRoot({ global: true }),
      QueueModule.forRoot({
        driver: new MemoryQueueDriver(),
        global: true,
      }),
      QueueModule.registerQueue({
        name: "orders",
        concurrency: 2,
      }),
    ],
    controllers: [OrdersController],
    providers: [
      CreateOrderHandler,
      OrdersProcessor,
      OrderEventAuditListener,
    ],
  })
  class DistributedWorkerModule {}

  return DistributedWorkerModule;
}

export const AppModule = createDistributedWorkerModule();
