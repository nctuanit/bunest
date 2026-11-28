import { Injectable } from "@bunest/core";
import { OnEvent } from "@bunest/messaging/events";

@Injectable()
export class OrderEventAuditListener {
  public readonly processedOrders: number[] = [];

  @OnEvent("order.processed")
  onOrderProcessed(payload: { orderId: number }): void {
    this.processedOrders.push(payload.orderId);
  }
}
