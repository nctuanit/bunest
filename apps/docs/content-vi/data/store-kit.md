# Store Kit (`@bunest/orm/store`)

**`@bunest/orm`** tích hợp sẵn bộ công cụ SQL store nền tảng zero-dependency xây dựng trực tiếp trên **`Bun.SQL`**. Đây là lõi vận hành các durable SQL store trong [`@bunest/messaging/outbox`](/distributed/outbox-webhooks), [`@bunest/messaging/webhooks`](/distributed/outbox-webhooks) và [`@bunest/workflows`](/distributed/workflows), đồng thời cho phép bạn tự xây dựng SQL store có phiên bản và an toàn giao dịch.

## Cài đặt

```bash
bun add @bunest/orm
```

## Các Subpath Exports

| Subpath | Mục đích |
| --- | --- |
| `@bunest/orm/store` | `SqlExecutor`, `SqlTransaction`, hàm ép kiểu an toàn (`toBool`, `toInt`, `toJson`, `toText`), `isNotATransactionError` và `runStoreCli` |
| `@bunest/orm/postgres` | Migration runner cho PostgreSQL, advisory locking và dialect helpers trên `Bun.SQL` |
| `@bunest/orm/mysql` | Migration runner cho MySQL / MariaDB và dialect helpers trên `Bun.SQL` |
| `@bunest/orm/testing` | Bộ contract test tái sử dụng và harness kiểm thử SQL store tạm thời |

## Xây dựng Typed SQL Store

Kết hợp `SqlExecutor` cùng các hàm ép kiểu an toàn (`toText`, `toInt`, `toBool`, `toJson`) để store hoạt động nhất quán trên cả PostgreSQL lẫn MySQL:

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
  metadata: Record<string, unknown>;
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
      metadata: toJson<Record<string, unknown>>(row.metadata),
    }));
  }
}
```

## Migration DDL có phiên bản & `runStoreCli`

Các package sử dụng SQL store đều đi kèm DDL migration có phiên bản quản lý qua `runStoreCli`:

- Kiểm tra trạng thái phiên bản migration (`status`).
- Áp dụng DDL migration trong transaction/lock (`migrate`).
- Xác minh tính toàn vẹn schema trên CI trước khi triển khai pod mới (`verify`).

## Contract Testing (`@bunest/orm/testing`)

Import bộ contract test từ `@bunest/orm/testing` để kiểm chứng store tự viết trên cả PostgreSQL, MySQL và in-memory ngay trong `bun test`.
