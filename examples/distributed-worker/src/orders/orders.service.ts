import { Injectable } from "@bunest/core";
import type { OrderRecord } from "./order.entity";
import { OrderRepository } from "./order.repository";

@Injectable()
export class OrdersService {
  constructor(private readonly orders: OrderRepository) {}

  findById(id: number): Promise<OrderRecord | null> {
    return this.orders.findById(id);
  }
}
