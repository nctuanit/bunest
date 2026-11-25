# SQL (`Bun.SQL` qua `@bunest/orm`)

**`@bunest/orm`** bao bọc driver đa dialect thuần Bun **`Bun.SQL`** (`BunSqlOrmDriver` — PostgreSQL, CockroachDB, MySQL, MariaDB và SQLite) cùng các driver SQL HTTP ở edge (`LibSqlOrmDriver` cho Turso/LibSQL và `D1OrmDriver` cho Cloudflare D1) và `ReplicatedOrmDriver` (định tuyến master/read-replica) với connection pooling qua DI, giao dịch `AsyncLocalStorage` (`@Transactional`), migration theo phiên bản (`OrmMigrationRunner`), và các repository khai báo nhận biết dialect được biên dịch một lần (`@OrmRepository` + `CrudRepository`).

## Cài đặt

```bash
bun add @bunest/orm
```

## Thiết lập Module

Cấu hình `OrmModule.forRoot()` (hoặc `OrmModule.forRootAsync()`) với loại cơ sở dữ liệu và URL kết nối hoặc thông tin xác thực:

@@filename(app.module.ts)

```ts
import { Module } from "@bunest/core";
import { OrmModule } from "@bunest/orm";
import { OrderRepository } from "./order.repository";

@Module({
  imports: [
    OrmModule.forRoot({
      type: "postgres", // "postgres" | "cockroachdb" | "mysql" | "mariadb" | "sqlite" | "libsql" | "d1"
      url: process.env.DATABASE_URL!,
      autoMigrate: true,
    }),
    OrmModule.forFeature([OrderRepository]),
  ],
})
export class AppModule {}
```

## Repository khai báo nhận biết Dialect

`@OrmRepository` + `CrudRepository` tự động sinh placeholder và trích dẫn định danh đúng theo dialect (`$1` / `"id"` / `RETURNING *` trên PostgreSQL; `?` / `` `id` `` trên MySQL/MariaDB; `?` / `"id"` trên SQLite/LibSQL/D1):

@@filename(order.repository.ts)

```ts
import {
  Column,
  CrudRepository,
  Entity,
  Modifying,
  OrmRepository,
  PrimaryGeneratedColumn,
  Query,
  SqlParam,
} from "@bunest/orm";

@Entity("orders")
export class Order {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  customerId: string;

  @Column()
  status: string;

  @Column({ type: "integer" })
  totalCents: number;
}

@OrmRepository(Order)
export abstract class OrderRepository extends CrudRepository<Order, number> {
  abstract findAllByCustomerIdOrderByIdDesc(customerId: string): Promise<Order[]>;
  abstract countByStatus(status: string): Promise<number>;

  @Modifying()
  @Query("UPDATE orders SET status = :status WHERE id = :id")
  abstract updateStatus(
    @SqlParam("id") id: number,
    @SqlParam("status") status: string,
  ): Promise<number>;
}
```

## Giao dịch khai báo `@Transactional()`

`@Transactional()` lan truyền giao dịch đang hoạt động và các `SAVEPOINT` lồng nhau xuyên suốt các service được tiêm, `Repository<Entity>` và proxy `CrudRepository` thông qua `AsyncLocalStorage`:

@@filename(checkout.service.ts)

```ts
import { Injectable } from "@bunest/core";
import { Transactional } from "@bunest/orm";
import { OrderRepository } from "./order.repository";

@Injectable()
export class CheckoutService {
  constructor(private readonly orders: OrderRepository) {}

  @Transactional()
  async markPaid(orderId: number) {
    return this.orders.updateStatus(orderId, "paid");
  }
}
```
