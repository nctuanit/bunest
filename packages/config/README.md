# @bunest/config

Typed environment loading, schema validation, configuration namespaces, conditional modules, and secret redaction for Bunest with zero external runtime dependencies.

## Features

- **Typed Configuration Service**: `ConfigService` with dot-path type inference (`Path<T>`, `PathValue<T, P>`), `get()`, `getOrThrow()`, defaults, and change subscriptions.
- **`.env` Parsing & Expansion**: Built-in `parseEnvContent()`, `loadEnvironmentVariables()`, and variable expansion (`expandEnvEntries()`) with no `dotenv` dependency.
- **Namespaces & Decorators**: `registerAs()` for strongly typed configuration namespaces, `@InjectConfig()`, and `@ConfigValue()`.
- **Validation & Conditional Modules**: `validateConfiguration()` (`ConfigValidationError`) with `@bunest/validation` support, plus `ConditionalModule` to register modules based on environment conditions.
- **Secret Redaction**: `createSecretRedactor()` masks sensitive configuration keys before logging.

## Installation

```bash
bun add @bunest/config
```

## Quick Start

```ts
import { Injectable, Module } from "@bunest/common";
import { ConfigModule, ConfigService, registerAs } from "@bunest/config";

const databaseConfig = registerAs("database", () => ({
  url: process.env.DATABASE_URL ?? "sqlite://:memory:",
  poolSize: Number(process.env.DB_POOL_SIZE ?? 10),
}));

@Injectable()
export class AppService {
  constructor(private readonly config: ConfigService) {}

  getDatabaseUrl(): string {
    return this.config.getOrThrow<string>("database.url");
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig],
    }),
  ],
  providers: [AppService],
})
export class AppModule {}
```

## Key Exports

- **Module & Service**: `ConfigModule` (`forRoot`, `forFeature`), `ConfigService`, `ConditionalModule`
- **Namespaces & Decorators**: `registerAs`, `getConfigToken`, `isNamespacedConfigFactory`, `@InjectConfig()`, `@ConfigValue()`
- **Env Loading & Validation**: `loadEnvironmentVariables`, `parseEnvContent`, `parseEnvEntries`, `expandEnvEntries`, `getDefaultParser`, `validateConfiguration`, `ConfigValidationError`, `createSecretRedactor`
- **Tokens**: `CONFIG_OPTIONS_TOKEN`, `CONFIG_STORE_TOKEN`, `CONFIGURATION_NAMESPACE_PREFIX`, `NAMESPACED_CONFIG_MARKER`, `CONFIG_VALUE_METADATA`

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
