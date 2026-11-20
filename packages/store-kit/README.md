# @bunest/store-kit

Foundational SQL store building blocks for **Bunest**'s first-party durable stores (`@bunest/outbox`, `@bunest/webhooks`, `@bunest/workflows`), with 100% `@nestjs/store-kit` API parity and zero external runtime dependencies.

## Features

- **Unified SQL Executor Contract**: `SqlExecutor`, `SqlTransaction`, `SqlTransactionOptions`, `SqlIsolationLevel`, and `SqlExecuteResult` abstract over PostgreSQL, MySQL/MariaDB, and Bun's native `Bun.SQL`.
- **Multi-Client Adapters**: First-class adapters for `pg`, `mysql2`, `Bun.SQL` (`fromBunSql`), Drizzle (`fromDrizzle`), TypeORM (`fromTypeOrm`), Prisma (`fromPrisma`), and Kysely (`fromKysely`).
- **Versioned Schema Migrations & CLI Runner**: `StoreSchema` and `runStoreCli()` power `migrate`, `status`, and `sql` CLI commands across store packages.
- **Dialect Helpers**: Safe parameter builders (`SqlParams`), identifier quoting, PostgreSQL advisory locks (`advisoryLock`, `assertReadCommittedTransaction`), and MySQL row-locking / deadlock retry helpers (`lockKeys`, `retryOnDeadlock`).
- **Compliance Testing**: Runner-agnostic `sqlExecutorContract()` test suite in `@bunest/store-kit/testing`.

## Installation

```bash
bun add @bunest/store-kit
```

## Quick Start

```ts
import { SQL } from "bun";
import { toInt, toText } from "@bunest/store-kit";
import { fromBunSql, SqlParams } from "@bunest/store-kit/postgres";

const sql = new SQL(process.env.DATABASE_URL!);
const executor = fromBunSql(sql);

const params = new SqlParams();
const idParam = params.push("ord_123");
const rows = await executor.query(
  `SELECT id, total FROM orders WHERE id = ${idParam}`,
  params.values,
);

const first = rows[0];
if (first) {
  console.log(toText(first.id), toInt(first.total));
}
```

## Key Exports

- **Core Helpers**: `runStoreCli`, `isNotATransactionError`, `toText`, `toInt`, `toBool`, `toJson`
- **Core Types**: `SqlExecutor`, `SqlTransaction`, `SqlTransactionOptions`, `SqlIsolationLevel`, `SqlExecuteResult`, `SqlDialect`, `StoreCliIo`

## Subpath Exports

- `@bunest/store-kit/postgres` — PostgreSQL executors (`fromPg`, `fromBunSql`, `fromDrizzle`, `fromTypeOrm`, `fromPrisma`, `fromKysely`), `StoreSchema`, `SqlParams`, `columns`, `quoteSchema`, `advisoryLock`, `assertReadCommittedTransaction`.
- `@bunest/store-kit/mysql` — MySQL 8.4+ / MariaDB executors (`fromMysql2`, `fromBunSql`, `fromDrizzle`, `fromTypeOrm`, `fromPrisma`, `fromKysely`), `StoreSchema`, `SqlParams`, `columns`, `quoteIdentifier`, `quoteTable`, `keyColumn`, `lockKeys`, `ensureLockRows`, `lockRowId`, `retryOnDeadlock`, `mysqlErrorCode`.
- `@bunest/store-kit/testing` — `sqlExecutorContract()` compliance test suite generator for PostgreSQL and MySQL executors.

## CLI

`@bunest/store-kit` exports `runStoreCli(schemas, argv)` to build standard `migrate`, `status`, and `sql` database migration CLIs (used by `nest-outbox`, `nest-webhooks`, and `nest-workflows`).

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
