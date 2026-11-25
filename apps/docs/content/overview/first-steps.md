# First steps

In this guide, you will configure a Bunest workspace, set up the mandatory `tsconfig.json` decorator options, and examine the core building blocks of a Bunest application.

## Requirements

Bunest targets **Bun `>= 1.4.5`** exclusively. Verify your local Bun runtime version first:

```bash
bun --version
# 1.4.5 or higher
```

## Installing dependencies

Install `@bunest/core` and `@bunest/validation` (zero external runtime dependencies — includes Bunest's built-in Reflect Metadata shim and compile-once DTO validator/transformer):

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

  const port = Number(Bun.env.PORT ?? 3000);
  await app.listen(port);
}

bootstrap();
```

## Minimal Project Structure

A clean NestJS-style Bunest application organizes domain features into self-contained modules:

```text
src/
├── main.ts                  # Application entrypoint
├── app.module.ts            # Root @Module() assembling feature modules
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

# Fast multi-threaded typecheck (Bun 1.4.5+)
bun check

# Run unit & integration tests via bun:test
bun test
```

> tip **Testing Note** Static typechecking (`bun check`) verifies types, not runtime decorator metadata emission. Always validate decorator reflection and HTTP routes in `bun test` with `@bunest/testing` (see [Testing](/fundamentals/testing) and [ADR-002](/architecture/adrs)).
