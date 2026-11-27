# Store Kit (`@bunest/orm/store`)

**`@bunest/orm`** includes Bunest's zero-dependency foundational SQL store toolkit built directly on **`Bun.SQL`**. It powers durable SQL stores across [`@bunest/messaging/outbox`](/distributed/outbox-webhooks), [`@bunest/messaging/webhooks`](/distributed/outbox-webhooks), and [`@bunest/workflows`](/distributed/workflows), and can be imported directly to build your own versioned, transaction-safe SQL stores.

## Installation

```bash
bun add @bunest/orm
```

## Subpath Exports

| Subpath | Purpose |
| --- | --- |
| `@bunest/orm/store` | `SqlExecutor`, `SqlTransaction`, value coercers (`toBool`, `toInt`, `toJson`, `toText`), `isNotATransactionError`, and `runStoreCli` |
| `@bunest/orm/postgres` | PostgreSQL migration runner, advisory locking, and dialect helpers over `Bun.SQL` |
| `@bunest/orm/mysql` | MySQL / MariaDB migration runner and dialect helpers over `Bun.SQL` |
| `@bunest/orm/testing` | Reusable store contract test suites and ephemeral SQL test harnesses |

## Building a Typed SQL Store

Use `SqlExecutor` and safe row coercers (`toText`, `toInt`, `toBool`, `toJson`) so your store works identically across PostgreSQL and MySQL drivers without brittle type casts:

@@filename(audit-log.store.ts)

```ts
import {
  toInt,
  toJson,
  toText,
  type SqlExecutor,
} from "@bunest/orm/store";

export interface AuditRecord {
  id: number;
  action: string;
  metadata: unknown;
}

export class AuditLogStore {
  constructor(private readonly db: SqlExecutor) {}

  async listRecent(limit = 20): Promise<AuditRecord[]> {
    const rows = await this.db.query(
      "SELECT id, action, metadata FROM audit_logs ORDER BY id DESC LIMIT $1",
      [limit],
    );
    return rows.map((row) => ({
      id: toInt(row.id),
      action: toText(row.action),
      metadata: toJson(row.metadata),
    }));
  }
}
```

## Versioned DDL Migrations & `runStoreCli`

Store-backed packages ship versioned SQL DDL migrations managed by `runStoreCli` from `@bunest/orm/store`:

- Inspect pending and applied migration versions (`status`).
- Apply forward DDL migrations inside a transaction/lock (`migrate`).
- Verify schema integrity in CI before deploying new application pods (`verify`).

## Contract Testing (`@bunest/orm/testing`)

Import reusable contract test harnesses from `@bunest/orm/testing` to validate custom store implementations against PostgreSQL, MySQL, and in-memory backends inside `bun test`.
