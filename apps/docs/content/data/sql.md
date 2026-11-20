# SQL (`Bun.SQL`)

**`@bunest/sql`** wraps Bun's native multi-dialect **`Bun.SQL`** driver (PostgreSQL, MySQL/MariaDB, and SQLite) with DI connection pooling, `AsyncLocalStorage` transactions (`@Transactional`), versioned migrations (`SqlMigrationRunner`), dialect-aware compiled-once declarative repositories (`@SqlRepository` + `SqlCrudRepository`), and first-class Drizzle/Prisma transaction integration.

## Installation

```bash
bun add @bunest/sql
```

## Module Setup

Configure `SqlModule.forRoot()` (or `forRootAsync()`) with a connection URL or dialect options:

@@filename(app.module.ts)
```ts
import { Module } from "@bunest/core";
import { SqlModule } from "@bunest/sql";
import { OrderRepository } from "./order.repository";

@Module({
  imports: [
    SqlModule.forRoot({
      url: process.env.DATABASE_URL!, // postgres://..., mysql://..., or sqlite://...
    }),
    SqlModule.forFeature([OrderRepository]),
  ],
})
export class AppModule {}
```

## Dialect-Aware Declarative Repositories

`@SqlRepository` + `SqlCrudRepository` automatically emits dialect-correct placeholders and identifier quoting (`$1` / `"id"` / `RETURNING *` on PostgreSQL; `?` / `` `id` `` on MySQL; `?` / `"id"` on SQLite):

@@filename(order.repository.ts)
```ts
import {
  Modifying,
  SqlCrudRepository,
  SqlParam,
  SqlQuery,
  SqlRepository,
} from "@bunest/sql";

export class Order {
  id!: number;
  customerId!: string;
  status!: string;
  totalCents!: number;
}

@SqlRepository({ entity: Order, table: "orders" })
export abstract class OrderRepository extends SqlCrudRepository<Order, number> {
  abstract findAllByCustomerIdOrderByIdDesc(customerId: string): Promise<Order[]>;
  abstract countByStatus(status: string): Promise<number>;

  @Modifying()
  @SqlQuery("UPDATE orders SET status = :status WHERE id = :id")
  abstract updateStatus(@SqlParam("id") id: number, @SqlParam("status") status: string): Promise<number>;
}
```

## Declarative `@Transactional()`

`@Transactional()` works across native `SqlService`, Drizzle (`{ adapter: "drizzle" }`), and Prisma (`{ adapter: "prisma" }`) connections:

@@filename(checkout.service.ts)
```ts
import { Injectable } from "@bunest/core";
import { Transactional } from "@bunest/sql";
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
