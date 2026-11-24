import {
  CrudRepository,
  IgnoreScope,
  OrmRepository,
  Projection,
  SoftDelete,
  type Page,
  type Pageable,
} from "@bunest/orm";
import "../magic/orm-operators";
import { OrderEntity } from "./order.entity";

/**
 * Showcase Declarative Repository demonstrating:
 * - `@SoftDelete()` implicit scope (adds `"deleted_at" IS NULL` and turns `deleteById` into soft-delete)
 * - `@Projection("id", "orderCode", "status")` selective column SQL projection
 * - `Page<T>` offset pagination via `findPageByStatus(...)`
 * - `@IgnoreScope("softDelete")` admin bypass
 * - Custom ORM query operator `IContains` (`findAllByOrderCodeIContains`)
 */
@OrmRepository(OrderEntity)
@SoftDelete()
export abstract class OrderRepository extends CrudRepository<OrderEntity, number> {
  abstract existsByOrderCode(orderCode: string): Promise<boolean>;

  abstract findAllByStatus(status: string): Promise<OrderEntity[]>;

  @Projection("id", "orderCode", "status")
  findByOrderCode(
    _orderCode: string,
  ): Promise<Pick<OrderEntity, "id" | "orderCode" | "status"> | null> {
    throw new Error("Implemented by @OrmRepository proxy");
  }

  abstract findPageByStatus(
    status: string,
    pageable: Pageable,
  ): Promise<Page<OrderEntity>>;

  @IgnoreScope("softDelete")
  countByStatus(_status: string): Promise<number> {
    throw new Error("Implemented by @OrmRepository proxy");
  }

  abstract findAllByOrderCodeIContains(fragment: string): Promise<OrderEntity[]>;
}
