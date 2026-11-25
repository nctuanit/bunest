# Modules

A module is a class annotated with the `@Module()` decorator. Modules organize your application into cohesive domain boundaries and define strict provider visibility rules.

## The `@Module()` Metadata Contract

```ts
export interface ModuleMetadata {
  imports?: Array<
    Type<any> | DynamicModule | Promise<DynamicModule> | ForwardReference
  >;
  controllers?: Type<any>[];
  providers?: Provider[];
  exports?: Array<
    | DynamicModule
    | Promise<DynamicModule>
    | Type<any>
    | Provider
    | string
    | symbol
    | ForwardReference
  >;
}
```

| Property      | Purpose                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------- |
| `providers`   | Services and custom providers instantiated by the DI container and **private to this module by default** |
| `controllers` | `@Controller()` classes belonging to this module                                                         |
| `imports`     | Other modules whose **exported** providers become visible inside this module                             |
| `exports`     | Subset of `providers` (or re-exported imported modules) made public to importing modules                 |

## Feature Modules & Encapsulation

Providers declared in a module are **encapsulated (private) by default**. To share `UsersService` with `OrdersModule`, `UsersModule` must explicitly list it in `exports`:

@@filename(users.module.ts)

```ts
import { Module } from "@bunest/core";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";
import { UsersRepository } from "./users.repository";

@Module({
  controllers: [UsersController],
  providers: [UsersService, UsersRepository],
  exports: [UsersService], // UsersRepository stays private to UsersModule!
})
export class UsersModule {}
```

@@filename(orders.module.ts)

```ts
import { Module } from "@bunest/core";
import { UsersModule } from "../users/users.module";
import { OrdersController } from "./orders.controller";
import { OrdersService } from "./orders.service";

@Module({
  imports: [UsersModule],
  controllers: [OrdersController],
  providers: [OrdersService], // Can inject UsersService, NOT UsersRepository
})
export class OrdersModule {}
```

## Module Re-Exporting & Deduplication

- **Static module deduplication:** Static `@Module()` classes are deduplicated by class identity across the entire graph. Importing `DatabaseModule` in both `UsersModule` and `OrdersModule` resolves to **one shared module instance** and shared singleton providers.
- **Module re-exports:** Listing an imported module in `exports` transitively re-exports all of its exported tokens. Re-exporting a module that is not in `imports` fails fast at bootstrap with `InvalidExportException`.
- **No accidental transitive leaks:** If `AppModule` imports `OrdersModule` and `OrdersModule` imports `UsersModule` without re-exporting it, `AppModule` cannot inject `UsersService`.

@@filename(core.module.ts)

```ts
import { Module } from "@bunest/core";
import { DatabaseModule } from "./database.module";

@Module({
  imports: [DatabaseModule],
  exports: [DatabaseModule], // Transitive re-export
})
export class CoreModule {}
```

## Global Modules (`@Global()`)

When a module provides ubiquitous utilities (database pools, config, caching), decorate it with `@Global()` so its **exported** providers become visible everywhere once imported in the root module:

@@filename(config.module.ts)

```ts
import { Global, Module } from "@bunest/core";
import { ConfigService } from "./config.service";

@Global()
@Module({
  providers: [ConfigService],
  exports: [ConfigService],
})
export class ConfigModule {}
```

> info **Encapsulation Still Applies** Non-exported providers inside a `@Global()` module remain private to that module. Unused `@Global()` classes that are never imported anywhere in the graph are not loaded.

## Dynamic Modules (`forRoot` / `registerAsync`)

Dynamic modules return a `DynamicModule` (or `Promise<DynamicModule>`) from a static method to parameterize providers at startup:

@@filename(database.module.ts)

```ts
import { Module, type DynamicModule } from "@bunest/core";

export const DB_OPTIONS = Symbol("DB_OPTIONS");

export interface DatabaseOptions {
  url: string;
  poolSize?: number;
}

@Module({})
export class DatabaseModule {
  static forRoot(options: DatabaseOptions): DynamicModule {
    return {
      module: DatabaseModule,
      global: true,
      providers: [
        { provide: DB_OPTIONS, useValue: options },
        // Additional connection providers...
      ],
      exports: [DB_OPTIONS],
    };
  }
}
```

Each distinct `DynamicModule` return object receives its own registration ID so multiple `forFeature(...)` instances never clobber each other, while reusing the exact same `DynamicModule` object reference deduplicates cleanly.

## Strict Token Resolution Precedence

When resolving token `T` inside module `M`, Bunest checks in deterministic order:

1. **`M`'s own local `providers`** (local always shadows imported or global tokens).
2. **`exports` of `M`'s direct `imports`** (including re-exports). If two imported modules export the same token `T` without a local override, Bunest fails fast with **`AmbiguousProviderException`**.
3. **`exports` of `@Global()` modules**. Two conflicting global exports also throw **`AmbiguousProviderException`**.
4. **Missing token:** Returns `undefined` if `@Optional()`, else fails fast with **`UnknownDependencyException`**.

## Smart `@AutoModule` (Directory Glob Scan & Static Manifest)

Zero-arg `@AutoModule()` auto-discovers classes from Bunest's `DecoratorRegistry`. Extended in **[ADR-018](/architecture/adrs)**, `@AutoModule()` also accepts native **`Bun.Glob`** directory scanning (`scan`), strict module scoping (zero global leakage), filters, profiles, and compile-time static `manifest` loaders:

```ts
export interface AutoModuleMetadata extends ModuleMetadata {
  readonly scan?: string | readonly string[];
  readonly exclude?: readonly string[]; // defaults: ["**/*.spec.ts", "**/*.test.ts", "**/*.d.ts"]
  readonly cwd?: string;
  readonly manifest?: readonly (() => Promise<Record<string, unknown> | object>)[];
  readonly filter?: (target: Type<unknown>) => boolean;
  readonly profiles?: readonly string[];
}
```

@@filename(orders.module.ts)

```ts
import { AutoModule } from "@bunest/core";

@AutoModule({
  scan: ["./controllers/**/*.ts", "./services/**/*.ts"],
  exclude: ["**/*.mock.ts"],
  filter: (target) => !target.name.startsWith("Internal"),
  profiles: ["production"],
})
export class OrdersModule {}
```

- **Strict per-module isolation:** Classes loaded by `scan` are registered only into the declaring `@AutoModule` — never leaked into unrelated modules.
- **Single-file executable support (`bun build --compile`):** When bundled through `@bunest/cli`'s unified [`createBunestPlugin()`](/observability/cli), Stage 2 (`autoModuleManifest`) expands `scan` at build time into a static `manifest: [() => import("./...")]` array. When `manifest` is present, it takes precedence over runtime globbing so compiled binaries work with zero filesystem scanning.
- **`BunestFactory.createAuto()`** also accepts `scan`, `exclude`, `cwd`, `manifest`, `filter`, and `profiles`.

## Conditional Beans (`@RegisterIf*` & `@Profile`)

Register providers or controllers conditionally based on runtime profiles, environment variables, custom predicates, or missing fallback bindings:

| Decorator | Evaluation Pass | Behavior |
| --- | --- | --- |
| `@RegisterIf(predicate)` | Pass 1 (eager) | Registers only when `predicate(ctx)` returns `true` (`ctx` exposes `env`, `profiles`, `registeredTokens`, `target`) |
| `@RegisterIfEnv(key, matcher?)` | Pass 1 (eager) | Without `matcher`: requires `Bun.env[key]` to be non-empty; also accepts exact `string`, `RegExp`, or `(value) => boolean` |
| `@Profile(...profiles)` | Pass 1 (eager) | Matches active profiles (e.g. `@Profile("production")`, `@Profile("dev", "staging")`, or negation `@Profile("!test")`) |
| `@RegisterIfMissing(token?)` | Pass 2 (deferred) | Registers a default fallback implementation ONLY if no explicit or earlier provider already provides `token` |

Active profiles for `@Profile(...)` resolve in deterministic precedence order:
`BunestCreateOptions.profiles` > `AutoModuleMetadata.profiles` > `Bun.env.BUNEST_PROFILES` > `Bun.env.BUNEST_PROFILE` > `Bun.env.NODE_ENV`.

@@filename(storage.providers.ts)

```ts
import {
  AutoModule,
  BunestFactory,
  Injectable,
  Profile,
  RegisterIf,
  RegisterIfEnv,
  RegisterIfMissing,
} from "@bunest/core";

export abstract class MailTransport {
  abstract send(to: string, body: string): Promise<void>;
}

@Injectable()
@Profile("production")
@RegisterIfEnv("SMTP_HOST")
export class SmtpMailTransport extends MailTransport {
  async send(to: string, body: string) {
    // Production SMTP transport
  }
}

@Injectable()
@Profile("!production")
@RegisterIf((ctx) => ctx.env.DISABLE_DEV_MAIL !== "1")
@RegisterIfMissing(MailTransport)
export class InMemoryMailTransport extends MailTransport {
  async send(to: string, body: string) {
    // Fallback registered only if no explicit MailTransport was registered!
  }
}

@AutoModule({
  providers: [
    { provide: MailTransport, useClass: SmtpMailTransport },
    { provide: MailTransport, useClass: InMemoryMailTransport },
  ],
  exports: [MailTransport],
})
export class MailModule {}

// Activate profiles explicitly at bootstrap:
// const app = await BunestFactory.create(AppModule, { profiles: ["production"] });
```

> info **Two-Pass Registration** `ModuleScanner` evaluates `@RegisterIf`, `@RegisterIfEnv`, and `@Profile` in pass 1, then evaluates `@RegisterIfMissing` in pass 2 against the settled token set — guaranteeing explicit user overrides always win cleanly without `DuplicateProviderException`.
