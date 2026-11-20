# Custom providers

Standard class providers (`providers: [UsersService]`) cover most cases, but Bunest's DI container supports all four custom provider forms defined in [ADR-007](/architecture/adrs): `useValue`, `useClass`, `useFactory` (sync or async), and `useExisting`.

## Provider Forms Overview

| Provider Kind | Syntax | Lifetime |
|---|---|---|
| Class shorthand | `UsersService` | `@Injectable({ scope })` (default `SINGLETON`) |
| `ClassProvider` | `{ provide: TOKEN, useClass: ImplClass, scope? }` | Explicit `scope` overrides decorator scope |
| `ValueProvider` | `{ provide: TOKEN, useValue: constantOrObj }` | Always `SINGLETON` |
| `FactoryProvider` | `{ provide: TOKEN, useFactory: (...deps) => ..., inject?, scope? }` | Sync or `async` factory |
| `ExistingProvider` | `{ provide: ALIAS, useExisting: TARGET }` | Shares the target provider's instance |

## Value Providers (`useValue`)

Bind configuration objects, constants, or test mocks to a symbol, string, or class token:

@@filename(app.module.ts)
```ts
import { Module } from "@bunest/core";

export const APP_CONFIG = Symbol("APP_CONFIG");

export interface AppConfig {
  env: "development" | "production";
  port: number;
}

@Module({
  providers: [
    {
      provide: APP_CONFIG,
      useValue: {
        env: Bun.env.NODE_ENV === "production" ? "production" : "development",
        port: Number(Bun.env.PORT ?? 3000),
      } satisfies AppConfig,
    },
  ],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
```

## Class Providers (`useClass`)

Swap implementations dynamically based on environment or feature flags:

@@filename(storage.module.ts)
```ts
import { Module } from "@bunest/core";
import { LocalStorageService } from "./local-storage.service";
import { S3StorageService } from "./s3-storage.service";
import { StorageService } from "./storage.abstract";

@Module({
  providers: [
    {
      provide: StorageService,
      useClass:
        Bun.env.STORAGE_DRIVER === "s3"
          ? S3StorageService
          : LocalStorageService,
    },
  ],
  exports: [StorageService],
})
export class StorageModule {}
```

## Async Factory Providers (`useFactory`)

`useFactory` lets you compute a provider dynamically—including **`async` initialization** (such as opening a `bun:sqlite` or `Bun.sql` connection pool). Bunest awaits async singleton factories in deterministic topological order during bootstrap before starting `Bun.serve()`:

@@filename(database.module.ts)
```ts
import { Module } from "@bunest/core";
import { Database } from "bun:sqlite";
import { APP_CONFIG, type AppConfig } from "./app.module";

export const SQLITE_DB = Symbol("SQLITE_DB");
export const METRICS_CLIENT = Symbol("METRICS_CLIENT");

@Module({
  providers: [
    {
      provide: SQLITE_DB,
      inject: [
        APP_CONFIG,
        { token: METRICS_CLIENT, optional: true }, // OptionalFactoryDependency
      ],
      useFactory: async (config: AppConfig, metrics?: { track: (k: string) => void }) => {
        const db = new Database(config.env === "production" ? "prod.sqlite" : ":memory:");
        db.run("PRAGMA journal_mode = WAL;");
        metrics?.track("db.connected");
        return db;
      },
    },
  ],
  exports: [SQLITE_DB],
})
export class DatabaseModule {}
```

## Alias Providers (`useExisting`)

Expose an existing provider under an additional token without instantiating a second copy:

@@filename(alias.module.ts)
```ts
import { Module } from "@bunest/core";
import { StructuredLogger } from "./structured-logger.service";

export const LOGGER_TOKEN = Symbol("LOGGER_TOKEN");

@Module({
  providers: [
    StructuredLogger,
    {
      provide: LOGGER_TOKEN,
      useExisting: StructuredLogger,
    },
  ],
  exports: [LOGGER_TOKEN],
})
export class LoggingModule {}
```

## Multi-Provider Enhancer Tokens

The global enhancer tokens **`APP_GUARD`**, **`APP_PIPE`**, **`APP_INTERCEPTOR`**, and **`APP_FILTER`** are registered as **multi-providers** inside `ModuleScanner` (`MULTI_PROVIDER_TOKENS`). Registering multiple `APP_GUARD` providers across different modules accumulates all of them in module bootstrap order instead of throwing `DuplicateProviderException`.
