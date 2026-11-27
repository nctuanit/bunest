# Bunest ORM (`@bunest/orm`)

Bunest tích hợp sẵn một bộ công cụ ORM và lưu trữ SQL hợp nhất, không phụ thuộc thư viện ngoài, thuần Bun — **`@bunest/orm`** — kết hợp sự tiện lợi của entity/relation kiểu TypeORM, các repository khai báo biên dịch một lần kiểu Spring Data (`@Repository` + `CrudRepository`), giao dịch `SAVEPOINT` lồng nhau dựa trên `AsyncLocalStorage` (`@Transactional`), migration theo phiên bản (`OrmMigrationRunner`), các subpath của SQL Store Kit (`./store`, `./postgres`, `./mysql`, `./testing`), và hỗ trợ đa cơ sở dữ liệu trên các API gốc của Bun (`bun:sqlite`, `Bun.SQL`, `fetch()` và `Bun.connect()`).

```bash
bun add @bunest/orm
```

## Cơ sở dữ liệu được hỗ trợ (100% Bun Native APIs)

| `type` cơ sở dữ liệu | Giao vận thuần Bun | Khả năng chính |
| --- | --- | --- |
| `sqlite`, `bun-sqlite`, `better-sqlite3`, `sqljs`, `expo`, `capacitor` | `bun:sqlite` (`SqliteOrmDriver`) hoặc `Bun.SQL` (`useBunSql: true`) | Chế độ WAL, `PRAGMA foreign_keys`, ALS savepoint, khóa tx FIFO |
| `postgres`, `postgresql`, `aurora-postgres`, `cockroachdb` | **`Bun.SQL`** (`BunSqlOrmDriver`, `adapter: "postgres"`) | Pool gốc, TLS, `$1..$n`, `RETURNING *`, `JSONB`, `ILIKE`, `search_path` |
| `mysql`, `mysql2`, `aurora-mysql`, `mariadb` | **`Bun.SQL`** (`BunSqlOrmDriver`, `adapter: "mysql"` / `"mariadb"`) | Pool gốc, TLS, `AUTO_INCREMENT`, MariaDB `RETURNING *` |
| `libsql`, `turso` | **Bun `fetch()`** (`LibSqlOrmDriver`, Hrana HTTP v2 `/v2/pipeline`) | Xác thực Bearer, tham số/hàng Hrana định kiểu, giao dịch baton tương tác |
| `d1` | **Bun `fetch()`** (`D1OrmDriver`, D1 REST API) hoặc `d1Binding` | Cloudflare D1 ở edge và từ xa |
| `mongodb`, `mongo` | **Bun `Bun.connect()`** (`MongoOrmDriver`, TCP/TLS `OP_MSG` + BSON + SCRAM-SHA-256) hoặc kho lưu trữ nhúng cục bộ | `MongoRepository<Entity>`, `@ObjectIdColumn()`, aggregation pipeline |
| `mssql`, `oracle`, `sap`, `spanner` | Trình biên dịch SQL dialect đầy đủ + `OrmDriverRegistry` | DDL thuần chính xác, trích dẫn định danh, placeholder, phân trang và câu lệnh upsert |

## Bắt đầu nhanh (Entity, Quan hệ & `OrmRepository<T>`)

@@filename(users.module.ts)

```ts
import { Injectable, Module } from "@bunest/core";
import {
  Column,
  Embedded,
  Entity,
  InjectRepository,
  ManyToOne,
  OneToMany,
  OrmModule,
  PrimaryGeneratedColumn,
  Transactional,
  type OrmRepository,
} from "@bunest/orm";

export class Address {
  @Column()
  city: string;
}

@Entity("users")
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true })
  email: string;

  @Embedded(() => Address)
  address?: Address;

  @OneToMany(() => Post, (post) => post.author, { cascade: true })
  posts: Post[];
}

@Entity("posts")
export class Post {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  title: string;

  @ManyToOne(() => User, (user) => user.posts, { onDelete: "CASCADE" })
  author: User;
}

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly users: OrmRepository<User>,
  ) {}

  @Transactional()
  createWithPosts(email: string, titles: string[]) {
    return this.users.save({
      email,
      posts: titles.map((title) => ({ title })),
    });
  }
}

@Module({
  imports: [
    OrmModule.forRoot({
      type: "sqlite",
      database: ":memory:",
      synchronize: true,
    }),
    OrmModule.forFeature([User, Post]),
  ],
  providers: [UsersService],
})
export class UsersModule {}
```

## Repository khai báo kiểu Spring Data (`@Repository` + `CrudRepository`)

Bên cạnh `OrmRepository<Entity>` (`@InjectRepository(Entity)`), `@bunest/orm` bao gồm một engine repository khai báo biên dịch một lần hoạt động trên tất cả các SQL dialect (`sqlite`, `postgres`, `mysql`, `mariadb`, `libsql`, `d1`):

@@filename(user.repository.ts)

```ts
import {
  CrudRepository,
  Repository,
} from "@bunest/orm";
import { User } from "./user.entity";

@Repository(User)
export abstract class UserRepository extends CrudRepository<User, number> {
  abstract findByEmail(email: string): Promise<User | null>;
  abstract existsByEmail(email: string): Promise<boolean>;

  async updateEmail(id: number, email: string): Promise<number> {
    const result = await this.execute("UPDATE users SET email = :email WHERE id = :id", { id, email });
    return result.affectedRows;
  }
}
```

Truyền `OrmModule.forFeature([UserRepository])` (hoặc bật `autoRegisterRepositories: true` trên `OrmModule.forRoot()`) và tiêm trực tiếp `UserRepository` theo kiểu class (`constructor(private readonly users: UserRepository)`).

## Toán tử truy vấn suy diễn tùy chỉnh (`registerQueryOperator`)

Mở rộng bộ phân tích truy vấn suy diễn kiểu Spring Data với các toán tử đặc thù theo miền nghiệp vụ hoặc dialect thông qua `registerQueryOperator()`. Các toán tử nằm trên registry toàn cục đơn realm `globalThis[Symbol.for("bunest:orm:custom_query_operators")]`, vì vậy công cụ chẩn đoán `@bunest/cli`, xem trước SQL và gợi ý tự động hoàn thành trong VS Code đều tự động nhận diện các hậu tố tùy chỉnh:

@@filename(custom-operators.ts)

```ts
import { registerQueryOperator } from "@bunest/orm";

registerQueryOperator({
  suffix: "Matches",
  arity: 1,
  description: "Full-text match predicate",
  toSql: ({ quotedColumn, nextPlaceholder, args }) => ({
    sql: `${quotedColumn} LIKE ${nextPlaceholder()}`,
    params: [`%${String(args[0])}%`],
  }),
});

// Now usable in any @Repository with longest-suffix matching:
// abstract findAllByBioMatchesAndActiveIsTrue(term: string): Promise<User[]>;
```

Các hàm trợ giúp registry bổ sung: `unregisterQueryOperator(suffix)`, `getRegisteredQueryOperator(suffix)`, `listRegisteredQueryOperators()` và `clearRegisteredQueryOperators()`.

## Phạm vi Repository ngầm định (`@RepositoryScope`, `@SoftDelete`, `@TenantScoped`)

Gắn các bộ lọc truy vấn cắt ngang có thể tái sử dụng và bộ chặn ghi dữ liệu trực tiếp lên các class `@Repository`:

| Decorator | Mục đích |
| --- | --- |
| `@RepositoryScope<TEntity>({ name, where?, beforeSave?, onDeleteById? })` | Scope tùy chỉnh có thể lặp lại, chèn mệnh đề `WHERE` (đóng ngoặc an toàn với `OR`), biến đổi `beforeSave`, hoặc bộ chặn `deleteById` |
| `@SoftDelete({ column?, property?, name?, now? })` | Mặc định dùng `deleted_at` / `deletedAt` / `"softDelete"`: thêm `<col> IS NULL` vào các thao tác đọc/đếm/kiểm tra tồn tại/xóa, chuyển `deleteById(id)` thành `UPDATE` xóa mềm, và cung cấp `softDeleteById`, `restoreById` cùng `hardDeleteById` |
| `@TenantScoped({ column?, property?, name?, resolveTenant?, required? })` | Phân giải tenant từ `resolveTenant()`, `ClsService` hoặc `getCurrentRequestContext()`, cô lập thao tác đọc/xóa theo `tenant_id`, và tự động điền `tenantId` khi `save()`/`saveMany()` |

Bạn cũng có thể vô hiệu hóa scope động xuyên qua các ranh giới bất đồng bộ bằng `runWithIgnoredScopes(["softDelete"], () => repo.findAll())`.

## Phân trang tích hợp sẵn (`Page<T>` & `CursorPage<T>`)

- **Phân trang theo offset (`Pageable` → `Page<T>`):** Dùng `findPageBy*` (hoặc truyền tham số `Pageable` ở cuối cho `findAllBy*`/`findBy*`). Trả về `{ items, total, page, size, totalPages, hasNext, hasPrevious }` tuân thủ các scope đang hoạt động và tùy chọn `sort: [{ property, direction }]`.
- **Phân trang theo keyset cursor (`CursorPageable` → `CursorPage<T>`):** Dùng `findCursorBy*` (hoặc truyền tham số `CursorPageable` ở cuối). Biên dịch `WHERE <cursorCol> >/< <cursor> ORDER BY <cursorCol> <dir> LIMIT (limit + 1)` và trả về `{ items, nextCursor, hasMore, limit }`.
- Các hàm trợ giúp: `createPageable(...)`, `createCursorPageable(...)`, `isPageable(v)` và `isCursorPageable(v)`.

## Các mảnh Repository có thể kết hợp (`composeRepository`)

Trộn các phương thức và scope repository tái sử dụng vào bất kỳ `@Repository` nào mà không bị giới hạn đơn kế thừa bằng **`defineRepositoryFragment()`** và **`composeRepository()`** — cùng với các trait tích hợp sẵn **`withSoftDelete()`** và **`withCursorPagination()`**:

@@filename(invoice.repository.ts)

```ts
import {
  CrudRepository,
  Repository,
  composeRepository,
  defineRepositoryFragment,
  withCursorPagination,
  withSoftDelete,
} from "@bunest/orm";
import { Invoice } from "./invoice.entity";

const withTableStats = defineRepositoryFragment<{ countRaw(): Promise<number> }>({
  name: "tableStats",
  createMethods: (ctx) => ({
    async countRaw() {
      const res = await ctx.driver.query<{ cnt: number }>(
        `SELECT COUNT(*) AS cnt FROM ${ctx.tableRef}`,
      );
      return Number(res.rows[0]?.cnt ?? 0);
    },
  }),
});

@Repository(Invoice)
export abstract class InvoiceRepository extends composeRepository(
  CrudRepository<Invoice, number>,
  withSoftDelete<Invoice, number>(),
  withCursorPagination<Invoice>({ defaultLimit: 25 }),
  withTableStats,
) {
  abstract findAllByStatus(status: string): Promise<Invoice[]>;
}
// InvoiceRepository exposes: softDeleteById, restoreById, hardDeleteById,
// findCursorPage, countRaw, plus all CrudRepository & derived finder methods!
```

## Các Subpath Export

| Subpath | Mục đích |
| --- | --- |
| `@bunest/orm` | ORM cốt lõi (`OrmModule`, `DataSource`, `EntityManager`, `Repository`, `MongoRepository`, `CrudRepository`, `@Repository`, `@Transactional`, `OrmMigrationRunner`, các driver, query builder) |
| `@bunest/orm/plugin` | Plugin Bun nạp trước cho entity tham chiếu vòng an toàn với TDZ |
| `@bunest/orm/store` | Bộ công cụ SQL store nền tảng (`runStoreCli`, `SqlExecutor`, `SqlTransaction`, các bộ ép kiểu giá trị) |
| `@bunest/orm/postgres` | Trình chạy migration & helper dialect PostgreSQL trên `Bun.SQL` gốc |
| `@bunest/orm/mysql` | Trình chạy migration & helper dialect MySQL / MariaDB trên `Bun.SQL` gốc |
| `@bunest/orm/testing` | Các bộ kiểm thử hợp đồng (contract test harness) tái sử dụng cho SQL store |

Xem thêm: [SQLite (`bun:sqlite`)](/data/sqlite), [SQL (`Bun.SQL`)](/data/sql), và [Store Kit (`@bunest/orm/store`)](/data/store-kit).
