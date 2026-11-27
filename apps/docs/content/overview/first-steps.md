# First steps

Get your first Bunest HTTP API running from a clean machine in a few minutes. By the end of this quickstart, you will have:

- `GET /health` returning HTTP `200` with `{"status":"ok"}`
- `GET /?name=Dev` returning HTTP `200` with `{"message":"Hello, Dev!","runtime":"Bun <version>"}`
- The example test suite passing with `bun run --cwd examples/hello-world test`

> info **Preview Notice** During preview, `@bunest/*` packages are not yet published to the public npm registry. The fastest way to try Bunest right now is running `examples/hello-world` directly from the public GitHub repository below.

## Prerequisites

Make sure **Git** and **Bun `>= 1.4.5`** are installed:

```bash
git --version
bun --version
# Bun 1.4.5 or higher
```

## Run Your First API (Source-First Preview)

### 1. Clone and install dependencies

Clone the public repository and install workspace dependencies from the repository root (`bunest`). No separate build step is required before starting the example.

```bash
git clone https://github.com/nctuanit/bunest.git
cd bunest
bun install --frozen-lockfile
```

### 2. Start the `hello-world` server

Run the example from the `bunest` repository root:

```bash
bun run --cwd examples/hello-world start
```

You should see:

```text
Bunest hello-world listening on http://localhost:3000
```

Keep this terminal running. Press `Ctrl+C` in this terminal whenever you want to stop the server.

If port `3000` is already in use, override `PORT` before starting:

**macOS / Linux:**

```bash
PORT=3001 bun run --cwd examples/hello-world start
```

**Windows PowerShell:**

```powershell
$env:PORT="3001"; bun run --cwd examples/hello-world start
```

### 3. Verify endpoints in a second terminal

Open a **second terminal** and send two requests (replace `3000` if you chose a custom `PORT`):

**macOS / Linux (`curl`):**

```bash
curl -i http://localhost:3000/health
curl -i "http://localhost:3000/?name=Dev"
```

**Windows PowerShell (`curl.exe`):**

```powershell
curl.exe -i http://localhost:3000/health
curl.exe -i "http://localhost:3000/?name=Dev"
```

Expected responses:

- `GET /health` returns HTTP `200` with:

```json
{"status":"ok"}
```

- `GET /?name=Dev` returns HTTP `200` with `message` set to `"Hello, Dev!"` and `runtime` matching your installed Bun version:

```json
{"message":"Hello, Dev!","runtime":"Bun 1.4.5"}
```

### 4. Run the example tests

From the `bunest` repository root (in the second terminal, or after stopping the server with `Ctrl+C`), run the example's automated test suite:

```bash
bun run --cwd examples/hello-world test
```

A passing run confirms that `TestingModule` and `app.fetch()` exercise both `GET /` and `GET /health` cleanly without opening a port.

## Choose Your Next Path

Once your first request and test pass, pick where to go next:

- **Create a project with CLI** — see [Create a Project with CLI](#create-a-project-with-cli) below (requires `@bunest/*` packages on npm or a configured registry).
- **Integrate into an existing project** — see [Integrate into an Existing Project](#integrate-into-an-existing-project) below for manual setup, `tsconfig.json` decorator metadata, and the `verbatimModuleSyntax` value-import rule.
- **Add validation** — jump to [Add Validation (DTOs)](#add-validation-dtos) below or read the full [Validation guide](/techniques/validation).

---

## Create a Project with CLI

> warning **Registry Prerequisite** The `bunx @bunest/cli` workflow below requires `@bunest/*` packages to be published on npm or available through your configured package registry. During preview, use the source-first flow above or run the CLI from a local monorepo checkout.

Once packages are available from your registry, use `@bunest/cli` to scaffold a ready-to-run project with legacy decorator settings, `bunest.json`, `bunfig.toml`, `preload.ts`, and an initial E2E test preconfigured:

```bash
bunx @bunest/cli new my-app
cd my-app
bun run dev
```

The generated project exposes `GET /` and `GET /health` out of the box (for production Kubernetes/proxy liveness and readiness probes like `/live` and `/ready`, add dedicated health endpoints via [`@bunest/observability`](/observability/observability) or follow `examples/production-rest-postgres`).

### Preload & `bunfig.toml`

`bunest new` generates `bunfig.toml` and `preload.ts` so Bun automatically registers the Bunest runtime plugin (enabling `@Repository<Entity>()` inference, and metadata transforms) for both `bun run` and `bun test`:

@@filename(bunfig.toml)

```toml
preload = ["./preload.ts"]
```

@@filename(preload.ts)

```ts
import { registerBunestPlugin } from "@bunest/cli";

registerBunestPlugin();
```

## Integrate into an Existing Project

If you are adding Bunest manually to an existing workspace (with `@bunest/*` available via npm or workspace links), install `@bunest/core` and `@bunest/validation` (zero external runtime dependencies — includes Bunest's built-in Reflect Metadata shim and compile-once DTO validator/transformer):

```bash
bun add @bunest/core @bunest/validation
bun add -d @types/bun typescript
```

> info **Hint** `@bunest/core` exports decorators, built-in pipes, `HttpException` classes, `Logger`, `Reflector`, and core HTTP/DI/Config/WS/I18n subpaths, and auto-installs a zero-dependency ECMAScript Reflect Metadata shim.

### TypeScript configuration (`tsconfig.json`)

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

### Application Entrypoint

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

## Add Validation (DTOs)

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
