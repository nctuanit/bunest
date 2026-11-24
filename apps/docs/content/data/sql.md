# SQL (`Bun.SQL` via `@bunest/orm`)

**`@bunest/orm`** wraps Bun's native multi-dialect **`Bun.SQL`** driver (`BunSqlOrmDriver` — PostgreSQL, CockroachDB, MySQL, MariaDB, and SQLite) plus edge HTTP SQL drivers (`LibSqlOrmDriver` for Turso/LibSQL and `D1OrmDriver` for Cloudflare D1) and `ReplicatedOrmDriver` (master/read-replica routing) with DI connection pooling, `AsyncLocalStorage` transactions (`@Transactional`), versioned migrations (`OrmMigrationRunner`), and dialect-aware compiled-once declarative repositories (`@OrmRepository` + `CrudRepository`).

## Installation

```bash
bun add @bunest/orm
```

## Module Setup

Configure `OrmModule.forRoot()` (or `OrmModule.forRootAsync()`) with a database type and connection URL or credentials:

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

## Dialect-Aware Declarative Repositories

`@OrmRepository` + `CrudRepository` automatically emits dialect-correct placeholders and identifier quoting (`$1` / `"id"` / `RETURNING *` on PostgreSQL; `?` / `` `id` `` on MySQL/MariaDB; `?` / `"id"` on SQLite/LibSQL/D1):

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
  id!: number;

  @Column()
  customerId!: string;

  @Column()
  status!: string;

  @Column({ type: "integer" })
  totalCents!: number;
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

## Declarative `@Transactional()`

`@Transactional()` propagates the active transaction and nested `SAVEPOINT`s across injected services, `Repository<Entity>`, and `CrudRepository` proxies via `AsyncLocalStorage`:

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
