# SQLite (`bun:sqlite` qua `@bunest/orm`)

**`@bunest/orm`** tích hợp trực tiếp driver `bun:sqlite` siêu nhanh thuần Bun (`SqliteOrmDriver`) vào Bunest với quản lý vòng đời DI (`OrmModule`), giao dịch `SAVEPOINT` lồng nhau lan truyền qua `AsyncLocalStorage` (`@Transactional`), migration SQL theo phiên bản (`OrmMigrationRunner`), `Repository<Entity>` kiểu TypeORM, và **các repository khai báo biên dịch một lần kiểu Spring Data** (`@Repository` + `CrudRepository`, [ADR-014](/architecture/adrs)).

## Cài đặt

```bash
bun add @bunest/orm
```

## Thiết lập Module

Đăng ký `OrmModule.forRoot({ type: "sqlite", ... })` (mặc định là global) và liên kết các entity hoặc repository khai báo bằng `OrmModule.forFeature()`:

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

## Repository khai báo kiểu Spring Data

Kế thừa `CrudRepository<TEntity, TKey>` và gắn decorator `@Repository()` lên abstract class. Tên các hàm tìm kiếm suy diễn được **biên dịch một lần khi khởi động** thành các truy vấn SQL có tham số hóa — không phân tích cú pháp SQL lúc chạy và bảo vệ chặt chẽ khỏi SQL injection:

@@filename(user.repository.ts)

```ts
import {
  Column,
  CrudRepository,
  Entity,
  Repository,
  PrimaryGeneratedColumn,
} from "@bunest/orm";

@Entity("users")
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "text", unique: true })
  email: string;

  @Column({ type: "text", default: "member" })
  role: string;

  @Column({ type: "boolean", default: true })
  active: boolean;
}

@Repository(User)
export abstract class UserRepository extends CrudRepository<User, number> {
  // Derived finders compiled once at startup:
  abstract findByEmail(email: string): Promise<User | null>;
  abstract findAllByRoleAndActiveOrderByIdDesc(
    role: string,
    active: boolean,
  ): Promise<User[]>;
  abstract existsByEmail(email: string): Promise<boolean>;
  abstract countByRole(role: string): Promise<number>;

  async deactivateByEmail(email: string): Promise<number> {
    const result = await this.execute("UPDATE users SET active = 0 WHERE email = :email", { email });
    return result.affectedRows;
  }
}
```

## Giao dịch khai báo `@Transactional()`

Gắn decorator `@Transactional()` lên các phương thức service. Các lời gọi `@Transactional()` lồng nhau tự động tạo `SAVEPOINT` trong SQLite thông qua `AsyncLocalStorage`, rollback sạch sẽ khi có lỗi được ném ra:

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

> info **`DataSource` trực tiếp & `OrmMigrationRunner`** Tiêm `DataSource` bất cứ khi nào bạn cần truy vấn thô có tham số (`dataSource.query(sql, params)`, `dataSource.transaction(...)`, `dataSource.ping()`), và tiêm `OrmMigrationRunner` (hoặc đặt `autoMigrate: true` / `migrationsRun: true`) để chạy các migration schema theo phiên bản có tính lũy đẳng khi khởi động.
