# Store Kit (`@bunest/orm/store`)

**`@bunest/orm`** tích hợp bộ công cụ SQL store nền tảng không phụ thuộc thư viện ngoài của Bunest, được xây dựng trực tiếp trên **`Bun.SQL`**. Bộ công cụ này vận hành các SQL store bền vững trong [`@bunest/messaging/outbox`](/distributed/outbox-webhooks), [`@bunest/messaging/webhooks`](/distributed/outbox-webhooks) và [`@bunest/workflows`](/distributed/workflows), đồng thời có thể được import trực tiếp cho các SQL store có quản lý phiên bản của riêng bạn.

## Cài đặt

```bash
bun add @bunest/orm
```

## Các Subpath Export

| Subpath                | Mục đích                                                                                                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@bunest/orm/store`    | Các interface thực thi SQL cốt lõi (`SqlExecutor`, `SqlTransaction`), các bộ ép kiểu giá trị (`toBool`, `toInt`, `toJson`, `toText`), `isNotATransactionError`, và `runStoreCli` |
| `@bunest/orm/postgres` | Trình chạy migration PostgreSQL, cơ chế khóa (locking) và các helper dialect trên `Bun.SQL`                                                                                 |
| `@bunest/orm/mysql`    | Trình chạy migration MySQL / MariaDB và các helper dialect trên `Bun.SQL`                                                                                                    |
| `@bunest/orm/testing`  | Các bộ kiểm thử hợp đồng tái sử dụng và harness kiểm thử store tạm thời                                                                                                      |

## CLI

`@bunest/orm/store` xuất `runStoreCli`, được các gói sử dụng store dùng để kiểm tra trạng thái migration, áp dụng các DDL migration theo phiên bản, và xác minh trạng thái schema trên các cơ sở dữ liệu PostgreSQL và MySQL.
