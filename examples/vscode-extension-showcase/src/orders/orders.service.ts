import { Injectable, NotFoundException, WithLogger } from "@bunest/core";
import type { Page } from "@bunest/orm";
import { AuditedOperation } from "../magic/aop-pipeline";
import { OrderEntity } from "./order.entity";
import { OrderRepository } from "./order.repository";

export interface CreateOrderInput {
  readonly orderCode: string;
  readonly status?: string;
  readonly totalCents: number;
}

@Injectable()
@WithLogger()
export class OrdersService {
  constructor(private readonly ordersRepo: OrderRepository) {}

  @AuditedOperation("orders.list")
  async listByStatus(
    status = "PAID",
    page = 1,
    size = 10,
  ): Promise<Page<OrderEntity>> {
    this.logger.log(`Listing orders status=${status} page=${page} size=${size}`);
    return this.ordersRepo.findPageByStatus(status, { page, size });
  }

  async searchByCode(fragment: string): Promise<OrderEntity[]> {
    return this.ordersRepo.findAllByOrderCodeIContains(fragment);
  }

  async findSummaryByCode(
    orderCode: string,
  ): Promise<Pick<OrderEntity, "id" | "orderCode" | "status">> {
    const summary = await this.ordersRepo.findByOrderCode(orderCode);
    if (!summary) {
      throw new NotFoundException(`Order "${orderCode}" not found`);
    }
    return summary;
  }

  async create(input: CreateOrderInput): Promise<OrderEntity> {
    return this.ordersRepo.save({
      orderCode: input.orderCode,
      status: input.status ?? "PAID",
      totalCents: input.totalCents,
    });
  }

  async softDelete(id: number): Promise<{ deleted: true; id: number }> {
    await this.ordersRepo.deleteById(id);
    return { deleted: true, id };
  }

  async countStats(status = "PAID"): Promise<{
    readonly status: string;
    readonly activeCount: number;
    readonly totalIncludingDeleted: number;
  }> {
    const [active, totalIncludingDeleted] = await Promise.all([
      this.ordersRepo.findAllByStatus(status),
      this.ordersRepo.countByStatus(status),
    ]);
    return {
      status,
      activeCount: active.length,
      totalIncludingDeleted,
    };
  }
}
