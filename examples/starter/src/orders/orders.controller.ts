import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from "@bunest/core";
import { CreateOrderDto, UpdateOrderStatusDto } from "./order.dto";
import type { OrderStatus } from "./order.entity";
import { OrdersService } from "./orders.service";

@Controller("orders")
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  findAll(@Query("status") status?: OrderStatus) {
    return this.ordersService.findAll(status);
  }

  @Get("stats")
  getStats() {
    return this.ordersService.getSalesSummary();
  }

  @Get(":id")
  findOne(@Param("id", ParseIntPipe) id: number) {
    return this.ordersService.findOne(id);
  }

  @Post()
  @HttpCode(201)
  placeOrder(@Body() dto: CreateOrderDto) {
    return this.ordersService.placeOrder(dto);
  }

  @Patch(":id/status")
  updateStatus(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateOrderStatusDto,
  ) {
    return this.ordersService.updateStatus(id, dto.status);
  }
}
