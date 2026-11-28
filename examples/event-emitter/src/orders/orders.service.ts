import { Injectable, NotFoundException } from "@bunest/core";
import { EmitEvent, EventEmitter2 } from "@bunest/messaging/events";
import type { CreateOrderDto } from "./dto/create-order.dto";
import { OrderCreatedEvent } from "./events/order-created.event";

export interface OrderRecord {
  readonly id: number;
  readonly name: string;
  readonly description: string;
  status: "pending" | "shipped";
}

@Injectable()
export class OrdersService {
  private readonly orders: OrderRecord[] = [
    {
      id: 1,
      name: "Order #1",
      description: "Initial seeded order",
      status: "pending",
    },
  ];
  private nextId = 2;

  constructor(private readonly eventEmitter: EventEmitter2) {}

  findAll(): OrderRecord[] {
    return [...this.orders];
  }

  async create(dto: CreateOrderDto): Promise<OrderRecord> {
    const order: OrderRecord = {
      id: this.nextId++,
      name: dto.name,
      description: dto.description,
      status: "pending",
    };
    this.orders.push(order);

    await this.eventEmitter.emitAsync(
      "order.created",
      new OrderCreatedEvent(order.id, order.name, order.description),
    );
    return order;
  }

  @EmitEvent("order.shipped")
  ship(id: number): OrderRecord {
    const order = this.orders.find((o) => o.id === id);
    if (!order) {
      throw new NotFoundException(`Order #${id} not found`);
    }
    order.status = "shipped";
    return { ...order };
  }
}
