# Store Kit

**`@bunest/store-kit`** is Bunest's zero-dependency foundational SQL persistence toolkit built directly on **`Bun.SQL`**. It powers durable SQL stores across [`@bunest/outbox`](/distributed/outbox-webhooks), [`@bunest/webhooks`](/distributed/outbox-webhooks), and [`@bunest/workflows`](/distributed/workflows), and can be used directly for your own versioned SQL stores.

## Installation

```bash
bun add @bunest/store-kit
```

## Subpath Exports

| Subpath | Purpose |
|---|---|
| `@bunest/store-kit` | Core SQL value coercion helpers (`toBool`, `toInt`, `toJson`, `toText`), transaction error guards (`isNotATransactionError`), and CLI runner (`runStoreCli`) |
| `@bunest/store-kit/postgres` | PostgreSQL migration runner, locking, and dialect helpers over `Bun.SQL` |
| `@bunest/store-kit/mysql` | MySQL / MariaDB migration runner and dialect helpers over `Bun.SQL` |
| `@bunest/store-kit/testing` | Reusable contract test suites and ephemeral store test harnesses |

## CLI

`@bunest/store-kit` ships a built-in CLI (`runStoreCli`) used by store-backed packages to inspect migration status, apply versioned DDL migrations, and verify schema state across PostgreSQL and MySQL databases.
