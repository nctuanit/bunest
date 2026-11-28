import { InjectQueue, Queue } from "@bunest/jobs/queues";
import { CommandHandler, type ICommandHandler } from "@bunest/messaging/cqrs";
import { Span, injectTraceContext } from "@bunest/observability";
import { CreateOrderCommand } from "./create-order.command";
import type { OrderRecord } from "./order.entity";
import { OrderRepository } from "./order.repository";
import type { ProcessOrderJobData } from "./orders.processor";

@CommandHandler(CreateOrderCommand)
export class CreateOrderHandler implements ICommandHandler<
  CreateOrderCommand,
  OrderRecord
> {
  constructor(
    private readonly orders: OrderRepository,
    @InjectQueue("orders")
    private readonly ordersQueue: Queue<
      ProcessOrderJobData,
      { orderId: number }
    >,
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
