import { Body, Controller, Get, Param, ParseIntPipe, Post } from "@bunest/core";
import { CreateOrderDto } from "./dto/create-order.dto";
import {
  OrderCreatedListener,
  type RecordedOrderEvent,
} from "./listeners/order-created.listener";
import { OrdersService, type OrderRecord } from "./orders.service";

@Controller("orders")
export class OrdersController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly listener: OrderCreatedListener,
  ) {}

  @Post()
  create(@Body() dto: CreateOrderDto): Promise<OrderRecord> {
    return this.ordersService.create(dto);
  }

  @Get()
  findAll(): OrderRecord[] {
    return this.ordersService.findAll();
  }

  @Get("events")
  getEvents(): RecordedOrderEvent[] {
    return [...this.listener.log];
  }

  @Post(":id/ship")
  ship(@Param("id", ParseIntPipe) id: number): OrderRecord {
    return this.ordersService.ship(id);
  }
}
