# First steps

In this guide, you will scaffold or configure a Bunest workspace, set up the mandatory `tsconfig.json` decorator options, define a validated DTO, and examine the core building blocks of a Bunest application.

## Requirements

Bunest targets **Bun `>= 1.4.5`** exclusively. Verify your local Bun runtime version first:

```bash
bun --version
# 1.4.5 or higher
```

## Scaffolding a New Project (Recommended)

Use `@bunest/cli` to scaffold a ready-to-run project with legacy decorator settings, `bunest.json`, `bunfig.toml`, `preload.ts`, and an initial E2E test preconfigured:

```bash
bunx @bunest/cli new my-app
cd my-app
bun run dev
```

The generated project exposes `GET /` and `GET /health` out of the box (for production Kubernetes/proxy liveness and readiness probes like `/live` and `/ready`, add dedicated health endpoints via [`@bunest/observability`](/observability/observability) or follow `examples/production-rest-postgres`).

### Preload & `bunfig.toml`

`bunest new` generates `bunfig.toml` and `preload.ts` so Bun automatically registers the Bunest runtime plugin (enabling zero-boilerplate class macros, `@Repository<Entity>()` inference, and metadata transforms) for both `bun run` and `bun test`:

@@filename(bunfig.toml)

```toml
preload = ["./preload.ts"]
```

@@filename(preload.ts)

```ts
import { registerBunestPlugin } from "@bunest/cli";

registerBunestPlugin();
```

## Manual Installation

If you prefer to wire a project manually, install `@bunest/core` and `@bunest/validation` (zero external runtime dependencies — includes Bunest's built-in Reflect Metadata shim and compile-once DTO validator/transformer):

```bash
bun add @bunest/core @bunest/validation
bun add -d @types/bun typescript
```

> info **Hint** `@bunest/core` exports decorators, built-in pipes, `HttpException` classes, `Logger`, `Reflector`, and core HTTP/DI/Config/WS/I18n subpaths, and auto-installs a zero-dependency ECMAScript Reflect Metadata shim.

## TypeScript configuration (`tsconfig.json`)

Bunest uses **Legacy TypeScript Decorators** to support constructor dependency injection (`design:paramtypes`), parameter decorators (`@Body()`, `@Param()`, `@Query()`), and `@bunest/validation` (or `class-validator`) DTOs.

@@filename(tsconfig.json)

```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "Preserve",
    "moduleDetection": "force",
    "moduleResolution": "bundler",
    "types": ["bun"],
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "verbatimModuleSyntax": true,
    "strict": true,
    "strictPropertyInitialization": false,
    "noEmit": true
  }
}
```

> warning **Critical `verbatimModuleSyntax` Rule** Always keep `verbatimModuleSyntax: true`. **Value-import** runtime classes used in decorated signatures (`import { UsersService }` and `import { CreateUserDto }`), and always **`import type`** TypeScript interfaces and type aliases (`import type { UserRecord }`). Using `import type` on a DI service or DTO erases its runtime metadata to `Object`, while value-importing an interface causes Bun's transpiler to fail at runtime.

## Application Entrypoint

`@bunest/core` auto-installs its zero-dependency Reflect Metadata shim, so no `import "reflect-metadata"` boilerplate is needed:

@@filename(src/main.ts)

```ts
import { BunestFactory } from "@bunest/core";
import { ValidationPipe } from "@bunest/validation";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await BunestFactory.create(AppModule);

  // Enable secure-by-default DTO validation globally
  app.useGlobalPipes(new ValidationPipe());
  app.enableShutdownHooks();

  const port = Number(Bun.env.PORT ?? 3000);
  await app.listen(port);
}

bootstrap();
```

## Defining a Validated DTO

Import validation decorators from `@bunest/validation/validator` (zero external dependencies) and value-import the DTO class in your controller:

@@filename(src/users/dto/create-user.dto.ts)

```ts
import {
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Min,
  MinLength,
} from "@bunest/validation/validator";

export class CreateUserDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(2)
  name!: string;

  @IsOptional()
  @IsInt()
  @Min(18)
  age?: number;
}
```

With `ValidationPipe` enabled globally, invalid payloads or unknown properties are rejected automatically with HTTP `400` and a normalized `{ statusCode, error, message, details }` envelope (see [Validation](/techniques/validation)).

## Minimal Project Structure

A clean NestJS-style Bunest application organizes domain features into self-contained modules:

```text
my-app/
├── bunfig.toml              # Registers ./preload.ts for bun run & bun test
├── preload.ts               # Calls registerBunestPlugin()
├── tsconfig.json            # Legacy decorators + verbatimModuleSyntax
└── src/
    ├── main.ts              # Application entrypoint
    ├── app.module.ts        # Root @Module() assembling feature modules
    └── users/
        ├── users.module.ts      # Feature @Module()
        ├── users.controller.ts  # HTTP @Controller("/users")
        ├── users.service.ts     # @Injectable() business logic
        └── dto/
            └── create-user.dto.ts
```

@@filename(src/app.module.ts)

```ts
import { Module } from "@bunest/core";
import { UsersModule } from "./users/users.module";

@Module({
  imports: [UsersModule],
})
export class AppModule {}
```

## Running & Typechecking

Bunest uses Bun's native tooling for running, testing, and fast multi-threaded typechecking:

```bash
# Run application in watch mode
bun --watch src/main.ts
# Or via CLI:
bun run dev

# Fast multi-threaded typecheck (Bun 1.4.5+)
bun check

# Run unit & integration tests via bun:test
bun test

# One-shot project check (typecheck + static diagnostics + tests)
bun run verify
```

> tip **Testing Note** Static typechecking (`bun check`) verifies types, not runtime decorator metadata emission. Always validate decorator reflection and HTTP routes in `bun test` with `@bunest/testing` (see [Testing](/fundamentals/testing) and [ADR-002](/architecture/adrs)).
