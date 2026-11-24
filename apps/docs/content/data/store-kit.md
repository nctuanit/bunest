# Store Kit (`@bunest/orm/store`)

**`@bunest/orm`** includes Bunest's zero-dependency foundational SQL store toolkit built directly on **`Bun.SQL`**. It powers durable SQL stores across [`@bunest/messaging/outbox`](/distributed/outbox-webhooks), [`@bunest/messaging/webhooks`](/distributed/outbox-webhooks), and [`@bunest/workflows`](/distributed/workflows), and can be imported directly for your own versioned SQL stores.

## Installation

```bash
bun add @bunest/orm
```

## Subpath Exports

| Subpath                | Purpose                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@bunest/orm/store`    | Core SQL executor interfaces (`SqlExecutor`, `SqlTransaction`), value coercers (`toBool`, `toInt`, `toJson`, `toText`), `isNotATransactionError`, and `runStoreCli` |
| `@bunest/orm/postgres` | PostgreSQL migration runner, locking, and dialect helpers over `Bun.SQL`                                                                                     |
| `@bunest/orm/mysql`    | MySQL / MariaDB migration runner and dialect helpers over `Bun.SQL`                                                                                          |
| `@bunest/orm/testing`  | Reusable contract test suites and ephemeral store test harnesses                                                                                             |

## CLI

`@bunest/orm/store` exports `runStoreCli`, used by store-backed packages to inspect migration status, apply versioned DDL migrations, and verify schema state across PostgreSQL and MySQL databases.
