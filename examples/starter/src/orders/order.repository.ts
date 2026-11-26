import { CrudRepository, Repository } from "@bunest/orm";
import { OrderEntity, type OrderStatus } from "./order.entity";

export interface SalesSummary {
  readonly totalOrders: number;
  readonly totalPairsSold: number;
  readonly totalRevenue: number;
}

@Repository(OrderEntity)
export abstract class OrderRepository extends CrudRepository<OrderEntity, number> {
  abstract findByOrderCode(orderCode: string): Promise<OrderEntity | null>;

  abstract findAllByStatus(status: OrderStatus): Promise<OrderEntity[]>;

  async getSalesSummary(): Promise<SalesSummary> {
    const row = await this.queryOne<{
      totalOrders: number;
      totalPairsSold: number | null;
      totalRevenue: number | null;
    }>(
      `SELECT
         COUNT(DISTINCT o.id) AS totalOrders,
         COALESCE(SUM(oi.quantity), 0) AS totalPairsSold,
         COALESCE((SELECT SUM(total_amount) FROM orders WHERE status != :cancelled), 0) AS totalRevenue
       FROM orders o
       LEFT JOIN order_items oi ON oi.order_id = o.id
       WHERE o.status != :cancelled`,
      { cancelled: "CANCELLED" },
    );

    return {
      totalOrders: Number(row?.totalOrders ?? 0),
      totalPairsSold: Number(row?.totalPairsSold ?? 0),
      totalRevenue: Number(row?.totalRevenue ?? 0),
    };
  }
}
