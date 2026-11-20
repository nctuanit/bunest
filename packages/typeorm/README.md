# @bunest/typeorm

TypeORM integration for **Bunest** with 100% `@nestjs/typeorm` v12 API parity and zero external runtime dependencies. Provides multi-DataSource DI lifecycle (`initialize()` / `destroy()`), retry/backoff, `autoLoadEntities`, custom `dataSourceFactory`, and a built-in Bun SQLite/in-memory `DataSource` runtime.

## Features

- **Full `@nestjs/typeorm` v12 Parity**: `TypeOrmModule` (`forRoot`, `forRootAsync`, `forFeature`), `@InjectRepository()`, `@InjectDataSource()`, `@InjectEntityManager()`, `@InjectConnection()`, and token helpers (`getRepositoryToken`, `getDataSourceToken`, `getEntityManagerToken`, `getConnectionToken`).
- **Multi-DataSource Lifecycle**: Isolated named DataSources via `DataSourceNameRegistry`, `autoLoadEntities`, automatic retry/backoff (`handleRetry`), and clean shutdown.
- **Built-In Zero-Dep Runtime**: Includes `DataSource`, `EntityManager`, `Repository`, `TreeRepository`, `MongoRepository`, and `EntitySchema` backed by Bun SQLite/in-memory storage for immediate local execution and testing.
- **Custom Repositories**: Register custom repositories with `@CustomRepository()`, `getCustomRepositoryToken()`, and `getCustomRepositoryEntity()`.

## Installation

```bash
bun add @bunest/typeorm
```

## Quick Start

```ts
import { Injectable, Module } from "@bunest/common";
import {
  InjectRepository,
  Repository,
  TypeOrmModule,
} from "@bunest/typeorm";

export class User {
  id!: number;
  email!: string;
}

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
  ) {}

  findAll() {
    return this.usersRepo.find();
  }
}

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: "sqlite",
      database: ":memory:",
      autoLoadEntities: true,
      synchronize: true,
    }),
    TypeOrmModule.forFeature([User]),
  ],
  providers: [UsersService],
})
export class AppModule {}
```

## Key Exports

- **Modules & Providers**: `TypeOrmModule`, `TypeOrmCoreModule`, `createTypeOrmProviders`, `handleRetry`
- **Decorators**: `InjectRepository`, `InjectDataSource`, `InjectEntityManager`, `InjectConnection`, `CustomRepository`
- **Runtime Classes**: `DataSource`, `EntityManager`, `Repository`, `TreeRepository`, `MongoRepository`, `EntitySchema`
- **Tokens, Registries & Errors**: `getRepositoryToken`, `getDataSourceToken`, `getEntityManagerToken`, `getConnectionToken`, `getCustomRepositoryToken`, `getCustomRepositoryEntity`, `getDataSourceName`, `getDataSourcePrefix`, `DEFAULT_DATA_SOURCE_NAME`, `DataSourceNameRegistry`, `EntitiesMetadataStorage`, `CircularDependencyException`, `DuplicateDataSourceException`

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
