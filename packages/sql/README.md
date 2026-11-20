# @bunest/sql

Unified database adapter contracts, native `Bun.SQL` module with `AsyncLocalStorage` transactions, declarative SQL repositories, schema DDL generation, and Drizzle/Prisma DI adapters for **Bunest** with zero external runtime dependencies.

## Features

- **Native `Bun.SQL` Integration**: `SqlModule` (`forRoot`, `forRootAsync`, `forFeature`) and `SqlService` with tagged template queries, named connections, and automatic lifecycle cleanup.
- **AsyncLocalStorage Transactions**: `@Transactional()` / `@SqlTransactional()` aspect decorators propagate active transactions transparently across nested service and repository calls.
- **Declarative Repositories & Entities**: Define schemas with `@Entity()`, `@Column()`, `@PrimaryGeneratedColumn()`, `@Index()`, `@Unique()`, generate DDL via `generateCreateTableSql()`, and build repositories with `@SqlRepository()`, `SqlCrudRepository`, `@Query()`, `@Modifying()`, and `@Param()`.
- **Built-In Migration Runner**: Track and execute versioned SQL migrations using `SqlMigrationRunner` and `@InjectSqlMigrations()`.
- **ORM DI Adapters**: Built-in `DrizzleModule` / `DrizzleService` and `PrismaModule` / `PrismaServiceBase` adapters with transactional aspects and `mapPrismaErrorToHttp()`.

## Installation

```bash
bun add @bunest/sql
```

## Quick Start

```ts
import { Injectable, Module } from "@bunest/common";
import {
  InjectSql,
  SqlModule,
  SqlService,
  Transactional,
} from "@bunest/sql";

@Injectable()
export class AccountsService {
  constructor(@InjectSql() private readonly sql: SqlService) {}

  @Transactional()
  async transfer(fromId: string, toId: string, amount: number) {
    await this.sql.query("UPDATE accounts SET balance = balance - $1 WHERE id = $2", [
      amount,
      fromId,
    ]);
    await this.sql.query("UPDATE accounts SET balance = balance + $1 WHERE id = $2", [
      amount,
      toId,
    ]);
  }
}

@Module({
  imports: [
    SqlModule.forRoot({
      url: process.env.DATABASE_URL ?? "sqlite://:memory:",
    }),
  ],
  providers: [AccountsService],
})
export class AppModule {}
```

## Key Exports

- **SQL Module & Services**: `SqlModule`, `SqlService`, `SqlMigrationRunner`, `InjectSql`, `InjectSqlMigrations`, `InjectSqlRepository`, `DEFAULT_SQL_CONNECTION`
- **Transactions**: `Transactional`, `SqlTransactional`, `SqlTransactionalAspect`, `DrizzleTransactionalAspect`, `PrismaTransactionalAspect`
- **Entities & Declarative Repositories**: `Entity`, `SqlEntity`, `Column`, `PrimaryKey`, `PrimaryGeneratedColumn`, `CreateDateColumn`, `UpdateDateColumn`, `Index`, `Unique`, `SqlRepository`, `SqlCrudRepository`, `DeclarativeSqlRepository`, `Query`, `SqlQuery`, `Modifying`, `Param`, `SqlParam`, `compileSqlRepository`, `generateCreateTableSql`
- **ORM Adapters**: `DrizzleModule`, `DrizzleService`, `InjectDrizzle`, `InjectDrizzleService`, `PrismaModule`, `PrismaServiceBase`, `InjectPrisma`, `InjectPrismaService`, `mapPrismaErrorToHttp`
- **Utilities & Tokens**: `assertSafeSqlIdentifier`, `quoteSqlIdentifier`, `normalizeSqlDialect`, `getSqlConnectionToken`, `getSqlRepositoryToken`, `getSqlMigrationRunnerToken`

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
