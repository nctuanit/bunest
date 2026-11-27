# Bunest ORM (`@bunest/orm`)

Bunest ships a single, unified, zero-dependency, Bun-native ORM and SQL persistence toolkit — **`@bunest/orm`** — combining TypeORM-style entity/relation ergonomics, Spring Data-style compiled-once declarative repositories (`@Repository` + `CrudRepository`), `AsyncLocalStorage` nested `SAVEPOINT` transactions (`@Transactional`), versioned migrations (`OrmMigrationRunner`), SQL Store Kit subpaths (`./store`, `./postgres`, `./mysql`, `./testing`), and multi-database support over Bun native APIs (`bun:sqlite`, `Bun.SQL`, `fetch()`, and `Bun.connect()`).

```bash
bun add @bunest/orm
```

## Supported Databases (100% Bun Native APIs)

| Database `type` | Bun Native Transport | Key Capabilities |
| --- | --- | --- |
| `sqlite`, `bun-sqlite`, `better-sqlite3`, `sqljs`, `expo`, `capacitor` | `bun:sqlite` (`SqliteOrmDriver`) or `Bun.SQL` (`useBunSql: true`) | WAL mode, `PRAGMA foreign_keys`, ALS savepoints, FIFO tx lock |
| `postgres`, `postgresql`, `aurora-postgres`, `cockroachdb` | **`Bun.SQL`** (`BunSqlOrmDriver`, `adapter: "postgres"`) | Native pool, TLS, `$1..$n`, `RETURNING *`, `JSONB`, `ILIKE`, `search_path` |
| `mysql`, `mysql2`, `aurora-mysql`, `mariadb` | **`Bun.SQL`** (`BunSqlOrmDriver`, `adapter: "mysql"` / `"mariadb"`) | Native pool, TLS, `AUTO_INCREMENT`, MariaDB `RETURNING *` |
| `libsql`, `turso` | **Bun `fetch()`** (`LibSqlOrmDriver`, Hrana HTTP v2 `/v2/pipeline`) | Bearer auth, typed Hrana args/rows, interactive baton transactions |
| `d1` | **Bun `fetch()`** (`D1OrmDriver`, D1 REST API) or `d1Binding` | Edge & remote Cloudflare D1 |
| `mongodb`, `mongo` | **Bun `Bun.connect()`** (`MongoOrmDriver`, TCP/TLS `OP_MSG` + BSON + SCRAM-SHA-256) or embedded local store | `MongoRepository<Entity>`, `@ObjectIdColumn()`, aggregation pipelines |
| `mssql`, `oracle`, `sap`, `spanner` | Full SQL dialect compiler + `OrmDriverRegistry` | Exact native DDL, quoting, placeholders, pagination, and upsert SQL |

## Quick Start (Entities, Relations & `OrmRepository<T>`)

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

## Spring Data-Style Declarative Repositories (`@Repository` + `CrudRepository`)

In addition to `OrmRepository<Entity>` (`@InjectRepository(Entity)`), `@bunest/orm` includes a compiled-once declarative repository engine working across all SQL dialects (`sqlite`, `postgres`, `mysql`, `mariadb`, `libsql`, `d1`):

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

Pass `OrmModule.forFeature([UserRepository])` (or enable `autoRegisterRepositories: true` on `OrmModule.forRoot()`) and inject `UserRepository` directly by class type (`constructor(private readonly users: UserRepository)`).

## Custom Derived Query Operators (`registerQueryOperator`)

Extend the Spring Data-style derived query parser with domain- or dialect-specific operators via `registerQueryOperator()`. Operators live on the single-realm global registry `globalThis[Symbol.for("bunest:orm:custom_query_operators")]`, so `@bunest/cli` diagnostics, SQL previews, and VS Code completions automatically recognize custom suffixes:

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

Additional registry helpers: `unregisterQueryOperator(suffix)`, `getRegisteredQueryOperator(suffix)`, `listRegisteredQueryOperators()`, and `clearRegisteredQueryOperators()`.

## Implicit Repository Scopes (`@RepositoryScope`, `@SoftDelete`, `@TenantScoped`)

Attach reusable, cross-cutting query filters and write interceptors directly onto `@Repository` classes:

| Decorator | Purpose |
| --- | --- |
| `@RepositoryScope<TEntity>({ name, where?, beforeSave?, onDeleteById? })` | Repeatable custom scope injecting `WHERE` clauses (with `OR`-safe parenthesization), `beforeSave` mutations, or `deleteById` interceptors |
| `@SoftDelete({ column?, property?, name?, now? })` | Defaults to `deleted_at` / `deletedAt` / `"softDelete"`: adds `<col> IS NULL` to reads/counts/exists/deletes, converts `deleteById(id)` to soft-delete `UPDATE`, and exposes `softDeleteById`, `restoreById`, and `hardDeleteById` |
| `@TenantScoped({ column?, property?, name?, resolveTenant?, required? })` | Resolves tenant from `resolveTenant()`, `ClsService`, or `getCurrentRequestContext()`, isolates reads/deletes by `tenant_id`, and auto-populates `tenantId` on `save()`/`saveMany()` |

You can also disable scopes dynamically across async boundaries using `runWithIgnoredScopes(["softDelete"], () => repo.findAll())`.

## First-Class Pagination (`Page<T>` & `CursorPage<T>`)

- **Offset pagination (`Pageable` → `Page<T>`):** Use `findPageBy*` (or pass a trailing `Pageable` to `findAllBy*`/`findBy*`). Returns `{ items, total, page, size, totalPages, hasNext, hasPrevious }` honoring active scopes and optional `sort: [{ property, direction }]`.
- **Keyset cursor pagination (`CursorPageable` → `CursorPage<T>`):** Use `findCursorBy*` (or pass a trailing `CursorPageable`). Compiles `WHERE <cursorCol> >/< <cursor> ORDER BY <cursorCol> <dir> LIMIT (limit + 1)` and returns `{ items, nextCursor, hasMore, limit }`.
- Helpers: `createPageable(...)`, `createCursorPageable(...)`, `isPageable(v)`, and `isCursorPageable(v)`.

## Composable Repository Fragments (`composeRepository`)

Mix reusable repository methods and scopes across any `@Repository` without single-inheritance limits using **`defineRepositoryFragment()`** and **`composeRepository()`** — alongside built-in **`withSoftDelete()`** and **`withCursorPagination()`** traits:

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

## Subpath Exports

| Subpath | Purpose |
| --- | --- |
| `@bunest/orm` | Core ORM (`OrmModule`, `DataSource`, `EntityManager`, `Repository`, `MongoRepository`, `CrudRepository`, `@Repository`, `@Transactional`, `OrmMigrationRunner`, drivers, query builders) |
| `@bunest/orm/plugin` | Bun TDZ-safe circular-entity preload plugin |
| `@bunest/orm/store` | Foundational SQL store kit (`runStoreCli`, `SqlExecutor`, `SqlTransaction`, value coercers) |
| `@bunest/orm/postgres` | PostgreSQL store migration & dialect helpers over native `Bun.SQL` |
| `@bunest/orm/mysql` | MySQL / MariaDB store migration & dialect helpers over native `Bun.SQL` |
| `@bunest/orm/testing` | Reusable SQL store contract test harnesses |

See also: [SQLite (`bun:sqlite`)](/data/sqlite), [SQL (`Bun.SQL`)](/data/sql), and [Store Kit (`@bunest/orm/store`)](/data/store-kit).
