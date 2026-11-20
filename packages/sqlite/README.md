# @bunest/sqlite

Native `bun:sqlite` database module for **Bunest** with zero external runtime dependencies. Features `AsyncLocalStorage` transactions with nested savepoints, schema migrations, entity metadata, and CRUD/declarative repository helpers.

## Features

- **Native `bun:sqlite` Driver**: `SqliteModule` (`forRoot`, `forRootAsync`, `forFeature`) and `SqliteService` supporting in-memory or file-backed SQLite databases and multiple named connections.
- **ALS Transactions & Nested Savepoints**: `@Transactional()` / `@SqliteTransactional()` propagate active transactions via `AsyncLocalStorage`, automatically using `SAVEPOINT` for nested calls.
- **Repositories & Entities**: `BaseSqliteRepository`, `JpaRepository`, `@SqliteRepository()` / `@Repository()`, `@Query()`, `@Modifying()`, `@Param()`, and entity decorators (`@Entity()`, `@Column()`, `@PrimaryGeneratedColumn()`, `@Index()`, `@Unique()`).
- **Schema Generation & Migrations**: `generateCreateTableSql()` for DDL generation and `SqliteMigrationRunner` (`@InjectSqliteMigrations()`) for tracked schema migrations.

## Installation

```bash
bun add @bunest/sqlite
```

## Quick Start

```ts
import { Injectable, Module } from "@bunest/common";
import {
  Column,
  Entity,
  InjectSqlite,
  PrimaryGeneratedColumn,
  SqliteModule,
  SqliteService,
  Transactional,
} from "@bunest/sqlite";

@Entity("tasks")
export class Task {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "text" })
  title!: string;
}

@Injectable()
export class TasksService {
  constructor(@InjectSqlite() private readonly db: SqliteService) {}

  @Transactional()
  create(title: string) {
    return this.db.run("INSERT INTO tasks (title) VALUES (?)", [title]);
  }

  findAll() {
    return this.db.all<Task>("SELECT * FROM tasks");
  }
}

@Module({
  imports: [
    SqliteModule.forRoot({
      filename: ":memory:",
    }),
  ],
  providers: [TasksService],
})
export class AppModule {}
```

## Key Exports

- **Module & Services**: `SqliteModule`, `SqliteService`, `SqliteMigrationRunner`, `InjectSqlite`, `InjectSqliteMigrations`, `InjectSqliteRepository`, `DEFAULT_SQLITE_CONNECTION`
- **Transactions**: `Transactional`, `SqliteTransactional`, `SqliteTransactionalAspect`
- **Entities & Repositories**: `Entity`, `SqliteEntity`, `Column`, `PrimaryKey`, `PrimaryGeneratedColumn`, `CreateDateColumn`, `UpdateDateColumn`, `Index`, `Unique`, `BaseSqliteRepository`, `DeclarativeSqliteRepository`, `JpaRepository`, `Repository`, `SqliteRepository`, `Query`, `SqliteQuery`, `Modifying`, `Param`, `SqlParam`, `compileSqliteRepository`, `generateCreateTableSql`
- **Exceptions & Utilities**: `DuplicateSqliteConnectionException`, `SqliteEntityNotFoundException`, `assertSafeSqlIdentifier`, `quoteSqlIdentifier`, `getSqliteConnectionToken`, `getSqliteRepositoryToken`, `getSqliteMigrationRunnerToken`

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
