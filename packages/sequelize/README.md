# @bunest/sequelize

Sequelize integration for **Bunest** with 100% `@nestjs/sequelize` v12 API parity and zero external runtime dependencies. Supports multi-connection DI lifecycle (`authenticate()`, `sync()`, `close()`), retry/backoff, `autoLoadModels`, `repositoryMode`, and a built-in Bun SQLite/in-memory `Sequelize` runtime.

## Features

- **Full `@nestjs/sequelize` v12 Parity**: `SequelizeModule` (`forRoot`, `forRootAsync`, `forFeature`), `@InjectModel()`, `@InjectConnection()`, `getModelToken()`, and `getConnectionToken()`.
- **Multi-Connection Lifecycle**: Isolated named connections with automatic retry/backoff (`handleRetry`), model auto-loading, and graceful shutdown.
- **Built-In Structural Runtime**: Zero-dependency `Sequelize`, `Model`, and `SequelizeRepository` implementations backed by Bun SQLite/in-memory storage for immediate local execution and testing.
- **Repository Mode & Metadata Storage**: `EntitiesMetadataStorage` and `repositoryMode` support for clean model injection.

## Installation

```bash
bun add @bunest/sequelize
```

## Quick Start

```ts
import { Injectable, Module } from "@bunest/common";
import {
  InjectModel,
  Model,
  SequelizeModule,
} from "@bunest/sequelize";

export class User extends Model {
  declare id: number;
  declare name: string;
}

@Injectable()
export class UsersService {
  constructor(@InjectModel(User) private readonly userModel: typeof User) {}

  findAll() {
    return this.userModel.findAll();
  }
}

@Module({
  imports: [
    SequelizeModule.forRoot({
      dialect: "sqlite",
      storage: ":memory:",
      autoLoadModels: true,
      synchronize: true,
    }),
    SequelizeModule.forFeature([User]),
  ],
  providers: [UsersService],
})
export class AppModule {}
```

## Key Exports

- **Modules & Providers**: `SequelizeModule`, `SequelizeCoreModule`, `createSequelizeProviders`, `handleRetry`
- **Decorators & Tokens**: `InjectModel`, `InjectConnection`, `getModelToken`, `getConnectionToken`, `getConnectionName`, `getConnectionPrefix`, `DEFAULT_CONNECTION_NAME`, `SEQUELIZE_CONNECTION_NAME`, `SEQUELIZE_MODULE_OPTIONS`, `SEQUELIZE_MODULE_ID`
- **Runtime & Storage**: `Sequelize`, `Model`, `SequelizeRepository`, `EntitiesMetadataStorage`, `CircularDependencyException`, `generateString`

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
