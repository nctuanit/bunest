# ORM & ODM Adapters

Bunest provides 5 official, zero-external-runtime-dependency ORM and ODM integration packages with 100% NestJS v12 DI ergonomics:

| Package | Integration | Key Exports |
|---|---|---|
| **`@bunest/prisma`** | Prisma Client + ALS transactions + HTTP exception filter | `PrismaModule`, `PrismaService`, `PrismaClientExceptionFilter`, `@InjectPrisma()` |
| **`@bunest/drizzle`** | Drizzle ORM + `@bunest/sql` ALS transactions | `DrizzleModule`, `@InjectDrizzle()`, `BunSqliteDrizzleDatabase` |
| **`@bunest/typeorm`** | `@nestjs/typeorm` v12 parity (multi-DataSource + SQLite/in-memory adapter) | `TypeOrmModule`, `@InjectRepository()`, `@InjectDataSource()`, `@InjectEntityManager()` |
| **`@bunest/mongoose`** | `@nestjs/mongoose` v12 parity (`@Schema`, `@Prop`, `SchemaFactory`, `IsObjectIdPipe`) | `MongooseModule`, `@InjectModel()`, `@InjectConnection()`, `Schema`, `Prop`, `SchemaFactory` |
| **`@bunest/sequelize`** | `@nestjs/sequelize` v12 parity (multi-connection + SQLite/in-memory adapter) | `SequelizeModule`, `@InjectModel()`, `@InjectConnection()`, `Model` |

## Prisma (`@bunest/prisma`)

```bash
bun add @bunest/prisma
```

@@filename(app.module.ts)
```ts
import { Module } from "@bunest/core";
import { PrismaClientExceptionFilter, PrismaModule, PrismaService } from "@bunest/prisma";

@Module({
  imports: [
    PrismaModule.forRoot({
      clientFactory: () => new PrismaClient(),
    }),
  ],
  providers: [PrismaClientExceptionFilter],
})
export class AppModule {}
```

`PrismaService` manages `$connect()`/`$disconnect()` lifecycle hooks, provides `transactionalClient` via `AsyncLocalStorage`, and pairs with `PrismaClientExceptionFilter` to map `P2002` / `P2025` Prisma errors to clean HTTP `409` / `404` responses.

## Drizzle (`@bunest/drizzle`)

```bash
bun add @bunest/drizzle
```

@@filename(app.module.ts)
```ts
import { Injectable, Module } from "@bunest/core";
import { DrizzleModule, InjectDrizzle } from "@bunest/drizzle";

@Module({
  imports: [
    DrizzleModule.forRoot({
      useFactory: () => createDrizzleInstance(),
    }),
  ],
})
export class AppModule {}

@Injectable()
export class UsersRepository {
  constructor(@InjectDrizzle() private readonly db: unknown) {}
}
```

## TypeORM (`@bunest/typeorm`)

```bash
bun add @bunest/typeorm
```

@@filename(users.module.ts)
```ts
import { Injectable, Module } from "@bunest/core";
import { InjectRepository, TypeOrmModule, type Repository } from "@bunest/typeorm";

class UserEntity {
  id!: number;
  email!: string;
}

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
  ) {}
}

@Module({
  imports: [
    TypeOrmModule.forRoot({ type: "sqlite", database: ":memory:", entities: [UserEntity] }),
    TypeOrmModule.forFeature([UserEntity]),
  ],
  providers: [UsersService],
})
export class UsersModule {}
```

## Mongoose (`@bunest/mongoose`)

```bash
bun add @bunest/mongoose
```

@@filename(cats.schema.ts)
```ts
import { InjectModel, MongooseModule, Prop, Schema, SchemaFactory } from "@bunest/mongoose";

@Schema({ timestamps: true })
export class Cat {
  @Prop({ required: true })
  name!: string;

  @Prop()
  age?: number;
}

export const CatSchema = SchemaFactory.createForClass(Cat);
```

Register with `MongooseModule.forRoot(uri)` and `MongooseModule.forFeature([{ name: Cat.name, schema: CatSchema }])`, and validate MongoDB ObjectIds with `IsObjectIdPipe`.

## Sequelize (`@bunest/sequelize`)

```bash
bun add @bunest/sequelize
```

Register connections with `SequelizeModule.forRoot(...)` and models with `SequelizeModule.forFeature([UserModel])`, then inject via `@InjectModel(UserModel)` or `@InjectConnection()`.
