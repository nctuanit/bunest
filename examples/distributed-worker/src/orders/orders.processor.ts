import { Process, Processor, type Job } from "@bunest/jobs/queues";
import { EmitEvent } from "@bunest/messaging/events";
import {
  Span,
  extractTraceContext,
  traceContextStorage,
} from "@bunest/observability";
import { OrderRepository } from "./order.repository";

export interface ProcessOrderJobData {
  readonly orderId: number;
  readonly failOnce?: boolean;
  readonly traceHeaders: Record<string, string>;
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
