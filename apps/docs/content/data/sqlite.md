# SQLite (`bun:sqlite` via `@bunest/orm`)

**`@bunest/orm`** integrates Bun's ultra-fast native `bun:sqlite` driver (`SqliteOrmDriver`) directly into Bunest with DI lifecycle management (`OrmModule`), `AsyncLocalStorage`-propagated nested `SAVEPOINT` transactions (`@Transactional`), versioned SQL migrations (`OrmMigrationRunner`), TypeORM-style `Repository<Entity>`, and **Spring Data-style compiled-once declarative repositories** (`@OrmRepository` + `CrudRepository`, [ADR-014](/architecture/adrs)).

## Installation

```bash
bun add @bunest/orm
```

## Module Setup

Register `OrmModule.forRoot({ type: "sqlite", ... })` (global by default) and bind entities or declarative repositories with `OrmModule.forFeature()`:

@@filename(app.module.ts)

```ts
import { Module } from "@bunest/core";
import { OrmModule } from "@bunest/orm";
import { UserRepository } from "./user.repository";

@Module({
  imports: [
    OrmModule.forRoot({
      type: "sqlite",
      database: "./app.db",
      enableWAL: true,
      enforceForeignKeys: true,
      synchronize: true,
    }),
    OrmModule.forFeature([UserRepository]),
  ],
})
export class AppModule {}
```

## Spring Data-Style Declarative Repositories

Extend `CrudRepository<TEntity, TKey>` and decorate the abstract class with `@OrmRepository()`. Derived finder names and `@Query()` templates are **compiled once at bootstrap** into parameterized SQL queries—zero runtime SQL parsing and strict SQL injection protection:

@@filename(user.repository.ts)

```ts
import {
  Column,
  CrudRepository,
  Entity,
  Modifying,
  OrmRepository,
  PrimaryGeneratedColumn,
  Query,
  SqlParam,
} from "@bunest/orm";

@Entity("users")
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "text", unique: true })
  email!: string;

  @Column({ type: "text", default: "member" })
  role!: string;

  @Column({ type: "boolean", default: true })
  active!: boolean;
}

@OrmRepository(User)
export abstract class UserRepository extends CrudRepository<User, number> {
  // Derived finders compiled once at startup:
  abstract findByEmail(email: string): Promise<User | null>;
  abstract findAllByRoleAndActiveOrderByIdDesc(
    role: string,
    active: boolean,
  ): Promise<User[]>;
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
import { Transactional } from "@bunest/orm";
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

> info **Direct `DataSource` & `OrmMigrationRunner`** Inject `DataSource` whenever you need raw parameterized queries (`dataSource.query(sql, params)`, `dataSource.transaction(...)`, `dataSource.ping()`), and inject `OrmMigrationRunner` (or set `autoMigrate: true` / `migrationsRun: true`) to run idempotent versioned schema migrations at startup.
