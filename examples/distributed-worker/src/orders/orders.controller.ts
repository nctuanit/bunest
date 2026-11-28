import { Body, Controller, Get, Param, Post } from "@bunest/core";
import { CommandBus } from "@bunest/messaging/cqrs";
import { CreateOrderCommand } from "./create-order.command";
import type { OrderRecord } from "./order.entity";
import { OrdersService } from "./orders.service";

@Controller("/orders")
export class OrdersController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly ordersService: OrdersService,
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
    return this.ordersService.findById(Number(id));
  }
}
