# @bunest/drizzle

Drizzle ORM integration for Bunest with 100% `@nestjs/drizzle` API parity, automatic client shutdown and error watching, built-in `bun:sqlite` Drizzle runtime helper, and seamless `@bunest/sql` AsyncLocalStorage transaction integration.

## Features

- **Full `@nestjs/drizzle` Parity**: `DrizzleModule.forRoot()` and `forRootAsync()` (`useFactory`, `useClass`, `useExisting`), named connections, `@InjectDrizzle(name?)`, and `getDrizzleToken(name?)`.
- **Automatic Lifecycle Management**: Tracks and closes `$client`, `$primary`, and `$replicas` automatically on application shutdown (`closeDrizzleClient`, `getDrizzleClients`, `watchDrizzleClient`).
- **Bun SQLite Runtime Helper**: `createBunSqliteDrizzle()` and `BunSqliteDrizzleDatabase` for zero-setup local/test Drizzle databases on `bun:sqlite`.
- **`@bunest/sql` Integration**: Re-exports `DrizzleService`, `@InjectDrizzleService()`, and `getDrizzleServiceToken()` for AsyncLocalStorage-propagated transactions.

## Installation

```bash
bun add @bunest/drizzle
```

## Quick Start

```ts
import { Injectable, Module } from "@bunest/common";
import {
  DrizzleModule,
  InjectDrizzle,
  createBunSqliteDrizzle,
  type BunSqliteDrizzleDatabase,
} from "@bunest/drizzle";

@Injectable()
export class UsersRepository {
  constructor(
    @InjectDrizzle() private readonly db: BunSqliteDrizzleDatabase,
  ) {}

  findAll() {
    return this.db.all("SELECT * FROM users");
  }
}

@Module({
  imports: [
    DrizzleModule.forRoot({
      db: createBunSqliteDrizzle(":memory:"),
    }),
  ],
  providers: [UsersRepository],
})
export class AppModule {}
```

## Key Exports

- **Modules**: `DrizzleModule` (`forRoot`, `forRootAsync`), `DrizzleCoreModule`
- **Decorators & Tokens**: `@InjectDrizzle()`, `getDrizzleToken`, `DEFAULT_CONNECTION_NAME`, `DRIZZLE_INSTANCE`, `DRIZZLE_MODULE_DATABASE`, `DRIZZLE_MODULE_ID`, `DRIZZLE_MODULE_OPTIONS`
- **Client Lifecycle & Bun SQLite**: `createBunSqliteDrizzle`, `BunSqliteDrizzleDatabase`, `closeDrizzleClient`, `getDrizzleClients`, `watchDrizzleClient`
- **`@bunest/sql` Integration**: `DrizzleService`, `@InjectDrizzleService()`, `getDrizzleServiceToken`

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
