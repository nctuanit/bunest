import { Injectable } from "@bunest/core";
import { OnEvent } from "@bunest/messaging/events";
import type { OrderCreatedEvent } from "../events/order-created.event";

export interface RecordedOrderEvent {
  readonly handler: string;
  readonly summary: string;
}

@Injectable()
export class OrderCreatedListener {
  public readonly log: RecordedOrderEvent[] = [];

  @OnEvent("order.created")
  handleOrderCreated(event: OrderCreatedEvent): void {
    this.log.push({
      handler: "order.created",
      summary: `Created order #${event.id}: ${event.name}`,
    });
  }

  @OnEvent("order.*", { async: true })
  async handleWildcardOrderEvent(payload: { id?: number; name?: string }): Promise<void> {
    await Bun.sleep(1);
    this.log.push({
      handler: "order.*",
      summary: `Wildcard audit for order #${payload?.id ?? "unknown"}`,
    });
  }

  @OnEvent("order.shipped")
  handleOrderShipped(payload: { id: number; status: string }): void {
    this.log.push({
      handler: "order.shipped",
      summary: `Shipped order #${payload.id} (${payload.status})`,
    });
  }
}
