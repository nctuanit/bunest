import {
  Repository,
  SoftDelete,
  runWithIgnoredScopes,
  type Page,
  type Pageable,
} from "@bunest/orm";
import "../magic/orm-operators";
import type { OrderEntity } from "./order.entity";

@Repository<OrderEntity, number>()
@SoftDelete()
export abstract class OrderRepository {
  abstract existsByOrderCode(orderCode: string): Promise<boolean>;

  abstract findAllByStatus(status: string): Promise<OrderEntity[]>;

  async findSummaryByOrderCode(
    orderCode: string,
  ): Promise<Pick<OrderEntity, "id" | "orderCode" | "status"> | null> {
    return this.queryOne<Pick<OrderEntity, "id" | "orderCode" | "status">>(
      'SELECT id, order_code AS orderCode, status FROM orders WHERE order_code = :orderCode AND deleted_at IS NULL LIMIT 1',
      { orderCode },
    );
  }

  abstract findPageByStatus(
    status: string,
    pageable: Pageable,
  ): Promise<Page<OrderEntity>>;

  abstract countByStatus(status: string): Promise<number>;

  countAllByStatusIncludingDeleted(status: string): Promise<number> {
    return runWithIgnoredScopes(["softDelete"], () =>
      this.countByStatus(status),
    );
  }

  abstract findAllByOrderCodeIContains(fragment: string): Promise<OrderEntity[]>;
}
