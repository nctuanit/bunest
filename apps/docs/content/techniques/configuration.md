# Configuration

Applications run across development, staging, test, and production environments. **`@bunest/core/config`** provides a typed, validated configuration layer with `.env` loading, `${VAR}` expansion, namespaced `registerAs()` factories, DTO and Standard Schema v1 validation, and declarative `@InjectConfig()` / `@ConfigValue()` decorators.

## Installation

```bash
bun add @bunest/core
```

## Getting Started

Register `ConfigModule.forRoot()` in your root module. Set `isGlobal: true` so `ConfigService` is available across every feature module without re-importing `ConfigModule`.

@@filename(app.module.ts)

```ts
import { Module } from "@bunest/core";
import { ConfigModule } from "@bunest/core/config";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [".env.local", ".env"],
      expandVariables: true,
    }),
  ],
})
export class AppModule {}
```

## Using `ConfigService`

Inject `ConfigService` into any provider or controller to read typed values with optional defaults or fail-fast `getOrThrow()`:

@@filename(database.service.ts)

```ts
import { Injectable } from "@bunest/core";
import { ConfigService } from "@bunest/core/config";

@Injectable()
export class DatabaseService {
  constructor(private readonly config: ConfigService) {}

  getConnectionUrl(): string {
    return this.config.getOrThrow<string>("DATABASE_URL");
  }

  getPoolSize(): number {
    return this.config.get<number>("DB_POOL_SIZE", 10);
  }
}
```

## Namespaced Configuration (`registerAs`)

Group related settings into strongly typed namespaces with `registerAs()` and inject them via `@Inject(dbConfig.KEY)` or `@InjectConfig(dbConfig)`:

@@filename(database.config.ts)

```ts
import { registerAs } from "@bunest/core/config";

export const databaseConfig = registerAs("database", () => ({
  host: process.env.DB_HOST ?? "localhost",
  port: Number(process.env.DB_PORT ?? 5432),
  name: process.env.DB_NAME ?? "bunest",
}));
```

@@filename(app.module.ts)

```ts
import { Module } from "@bunest/core";
import { ConfigModule } from "@bunest/core/config";
import { databaseConfig } from "./database.config";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig],
    }),
  ],
})
export class AppModule {}
```

## Declarative `@InjectConfig()` and `@ConfigValue()`

Eliminate manual `ConfigService.get()` boilerplate with declarative parameter and property decorators ([ADR-014](/architecture/adrs)):

@@filename(mail.service.ts)

```ts
import { Injectable } from "@bunest/core";
import { ConfigValue, InjectConfig } from "@bunest/core/config";
import { databaseConfig } from "./database.config";

@Injectable()
export class MailService {
  @ConfigValue("SMTP_HOST", "localhost")
  readonly smtpHost!: string;

  constructor(
    @InjectConfig(databaseConfig)
    private readonly db: ReturnType<typeof databaseConfig>,
    @InjectConfig("APP_NAME", "Bunest")
    private readonly appName: string,
  ) {}
}
```

## Validation & Conditional Modules

Validate environment variables at bootstrap using either a `@bunest/validation` (or `class-validator`) DTO (`validate`), a Standard Schema v1 validator (`validationSchema`, e.g. Zod/Valibot), or a custom function. Failed validation throws `ConfigValidationError` before `Bun.serve()` starts.

You can also conditionally load feature modules based on environment flags using `ConditionalModule.registerWhen()`:

@@filename(app.module.ts)

```ts
import { Module } from "@bunest/core";
import { ConditionalModule, ConfigModule } from "@bunest/core/config";
import { MetricsModule } from "@bunest/observability";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ConditionalModule.registerWhen(MetricsModule, "ENABLE_METRICS"),
  ],
})
export class AppModule {}
```

> info **Secret Redaction** `@bunest/core/config` includes a built-in secret redactor so sensitive keys (`SECRET`, `TOKEN`, `PASSWORD`, `API_KEY`) are masked when logging resolved configuration.
