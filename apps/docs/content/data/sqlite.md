# SQLite (`bun:sqlite`)

**`@bunest/sqlite`** integrates Bun's ultra-fast native `bun:sqlite` driver directly into Bunest with DI lifecycle management, `AsyncLocalStorage`-propagated nested `SAVEPOINT` transactions (`@Transactional`), versioned SQL migrations (`SqliteMigrationRunner`), and **Spring Data-style compiled-once declarative repositories** (`@SqliteRepository` + `JpaRepository`, [ADR-014](/architecture/adrs)).

## Installation

```bash
bun add @bunest/sqlite
```

## Module Setup

Register `SqliteModule.forRoot()` (global by default) and bind declarative repositories with `SqliteModule.forFeature()`:

@@filename(app.module.ts)
```ts
import { Module } from "@bunest/core";
import { SqliteModule } from "@bunest/sqlite";
import { UserRepository } from "./user.repository";

@Module({
  imports: [
    SqliteModule.forRoot({
      path: "./app.db",
      wal: true,
      foreignKeys: true,
    }),
    SqliteModule.forFeature([UserRepository]),
  ],
})
export class AppModule {}
```

## Spring Data-Style Declarative Repositories

Extend `JpaRepository<TEntity, TKey>` and decorate the abstract class with `@SqliteRepository()`. Derived finder names and `@Query()` templates are **compiled once at bootstrap** into parameterized SQL queries—zero runtime SQL parsing and strict SQL injection protection:

@@filename(user.repository.ts)
```ts
import {
  JpaRepository,
  Modifying,
  Query,
  SqliteRepository,
  SqlParam,
} from "@bunest/sqlite";

export class User {
  id!: number;
  email!: string;
  role!: string;
  active!: boolean;
}

@SqliteRepository({ entity: User, table: "users" })
export abstract class UserRepository extends JpaRepository<User, number> {
  // Derived finders compiled once at startup:
  abstract findByEmail(email: string): Promise<User | null>;
  abstract findAllByRoleAndActiveOrderByIdDesc(role: string, active: boolean): Promise<User[]>;
  abstract existsByEmail(email: string): Promise<boolean>;
  abstract countByRole(role: string): Promise<number>;

  // Custom parameterized @Query with @SqlParam:
  @Modifying()
  @Query("UPDATE users SET active = 0 WHERE email = :email")
  abstract deactivateByEmail(@SqlParam("email") email: string): Promise<number>;
}
```

## Declarative `@Transactional()`

Decorate service methods with `@Transactional()`. Nested `@Transactional()` calls automatically create SQLite `SAVEPOINT`s via `AsyncLocalStorage`, rolling back cleanly on thrown errors:

@@filename(users.service.ts)
```ts
import { Injectable } from "@bunest/core";
import { Transactional } from "@bunest/sqlite";
import { UserRepository } from "./user.repository";

@Injectable()
export class UsersService {
  constructor(private readonly users: UserRepository) {}

  @Transactional()
  async register(email: string) {
    return this.users.save({ email, role: "member", active: true });
  }
}
```

> info **Direct `SqliteService` & Migrations** Inject `SqliteService` whenever you need raw prepared statements (`query`, `run`, `transaction`, `transactionSync`), and use `SqliteMigrationRunner` to run idempotent schema migrations at startup.
