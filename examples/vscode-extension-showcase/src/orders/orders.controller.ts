import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
} from "@bunest/core";
import { OrdersService, type CreateOrderInput } from "./orders.service";

/**
 * 👉 Exposes `@SoftDelete`, `@Projection`, `Page<T>`, `@IgnoreScope("softDelete")`,
 *    and custom ORM operator `IContains` over HTTP (cleanly via `OrdersService` — no `BUNEST_ARCH001`!).
 */
@Controller("orders")
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  async list(
    @Query("status") status?: string,
    @Query("search") search?: string,
    @Query("page") page?: string,
    @Query("size") size?: string,
  ) {
    if (search) {
      const items = await this.ordersService.searchByCode(search);
      return { search, count: items.length, items };
    }
    return this.ordersService.listByStatus(
      status || "PAID",
      Number(page ?? 1),
      Number(size ?? 10),
    );
  }

  @Get("stats")
  async stats(@Query("status") status?: string) {
    return this.ordersService.countStats(status || "PAID");
  }

  @Get(":code")
  async summary(@Param("code") code: string) {
    return this.ordersService.findSummaryByCode(code);
  }

  @Post()
  async create(@Body() body: CreateOrderInput) {
    return this.ordersService.create(body);
  }

  @Delete(":id")
  async remove(@Param("id") id: string) {
    return this.ordersService.softDelete(Number(id));
  }
}
