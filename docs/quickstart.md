# Quickstart — Build a Validated REST CRUD API in < 15 Minutes

This guide walks through creating, running, documenting, and testing a complete NestJS-style REST CRUD API with **Bunest** on **Bun >= 1.4.5**.

---

## Prerequisites

- **Bun >= 1.4.5** (`bun --version`)
- No Node.js, Express, or Fastify required.

---

## Step 1: Scaffold a New Project with the Bunest CLI

Use the Bunest CLI (`@bunest/cli`) to scaffold a project with legacy decorator support preconfigured:

```bash
bunx @bunest/cli new users-api
cd users-api
```

Or initialize manually with the required `tsconfig.json` settings (see [ADR-002](./adr/ADR-002.md)):

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "Preserve",
    "moduleResolution": "bundler",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "verbatimModuleSyntax": true,
    "strict": true,
    "noEmit": true,
    "types": ["bun"]
  }
}
```

Install core dependencies:

```bash
bun add @bunest/core @bunest/validation @bunest/swagger
bun add -d @bunest/testing @types/bun
```

> **Important (`verbatimModuleSyntax: true`):** Always **value-import** DI service classes and DTO classes (`import { CreateUserDto } from "./create-user.dto"`) so Bun emits `design:paramtypes` metadata, and always use **`import type`** for TypeScript interfaces and type aliases (`import type { User } from "./user.interface"`).

---

## Step 2: Generate a CRUD Resource (Optional)

You can scaffold modules, controllers, services, DTOs, and specs with the CLI:

```bash
bunx @bunest/cli generate resource users
# Shorthand:
bunx @bunest/cli g res users
```

---

## Step 3: Define Validated DTOs (`src/users/dto/create-user.dto.ts`)

```ts
import {
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Min,
  MinLength,
} from "@bunest/validation/validator";
import { Type } from "@bunest/validation/transformer";
import { ApiProperty, ApiPropertyOptional } from "@bunest/swagger";

export class CreateUserDto {
  @ApiProperty({ example: "ada@bunest.dev" })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: "Ada Lovelace", minLength: 2 })
  @IsString()
  @MinLength(2)
  name!: string;

  @ApiPropertyOptional({ example: 28, minimum: 13 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(13)
  age?: number;
}

export class UpdateUserDto {
  @ApiPropertyOptional({ example: "Ada Byron" })
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @ApiPropertyOptional({ example: 29, minimum: 13 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(13)
  age?: number;
}
```

---

## Step 4: Create the Service (`src/users/users.service.ts`)

```ts
import { Injectable, NotFoundException } from "@bunest/core";
import type { CreateUserDto, UpdateUserDto } from "./dto/create-user.dto";

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  age?: number;
}

@Injectable()
export class UsersService {
  private readonly store = new Map<string, UserRecord>();
  private nextId = 1;

  findAll(): UserRecord[] {
    return [...this.store.values()];
  }

  findOne(id: string): UserRecord {
    const user = this.store.get(id);
    if (!user) {
      throw new NotFoundException(`User "${id}" not found`);
    }
    return user;
  }

  create(dto: CreateUserDto): UserRecord {
    const user: UserRecord = {
      id: `u_${this.nextId++}`,
      email: dto.email,
      name: dto.name,
      age: dto.age,
    };
    this.store.set(user.id, user);
    return user;
  }

  update(id: string, dto: UpdateUserDto): UserRecord {
    const existing = this.findOne(id);
    const updated: UserRecord = {
      ...existing,
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.age !== undefined ? { age: dto.age } : {}),
    };
    this.store.set(id, updated);
    return updated;
  }

  remove(id: string): void {
    this.findOne(id);
    this.store.delete(id);
  }
}
```

---

## Step 5: Create the Controller (`src/users/users.controller.ts`)

Notice how `UsersService`, `CreateUserDto`, and `UpdateUserDto` are **value-imported** (never `import type`) so constructor DI and `ValidationPipe` receive their runtime class constructors:

```ts
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from "@bunest/core";
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@bunest/swagger";
import { CreateUserDto, UpdateUserDto } from "./dto/create-user.dto";
import { UsersService } from "./users.service";

@ApiTags("users")
@Controller("/users")
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOperation({ summary: "List all users" })
  findAll() {
    return this.users.findAll();
  }

  @Get(":id")
  @ApiOperation({ summary: "Get a user by ID" })
  @ApiOkResponse({ description: "User found" })
  findOne(@Param("id") id: string) {
    return this.users.findOne(id);
  }

  @Post()
  @ApiOperation({ summary: "Create a user" })
  @ApiCreatedResponse({ description: "User created" })
  create(@Body() dto: CreateUserDto) {
    // POST defaults to HTTP 201 Created (ADR-010)
    return this.users.create(dto);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update a user" })
  update(@Param("id") id: string, @Body() dto: UpdateUserDto) {
    return this.users.update(id, dto);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Delete a user" })
  remove(@Param("id") id: string) {
    this.users.remove(id);
  }
}
```

---

## Step 6: Wire the Module & Entrypoint

`src/app.module.ts`:

```ts
import { Module } from "@bunest/core";
import { UsersController } from "./users/users.controller";
import { UsersService } from "./users/users.service";

@Module({
  controllers: [UsersController],
  providers: [UsersService],
})
export class AppModule {}
```

`src/main.ts` — `@bunest/core` includes a built-in zero-dependency Reflect Metadata shim ([ADR-017](./adr/ADR-017.md)), so no `import "reflect-metadata"` boilerplate is required:

```ts
import { BunestFactory, ValidationPipe } from "@bunest/core";
import { DocumentBuilder, SwaggerModule } from "@bunest/swagger";
import { AppModule } from "./app.module";

const app = await BunestFactory.create(AppModule);

// Secure defaults: whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true, transform: true
app.useGlobalPipes(new ValidationPipe());

// OpenAPI 3.1 + Interactive Swagger UI
const swaggerConfig = new DocumentBuilder()
  .setTitle("Users API")
  .setDescription("Validated REST CRUD powered by Bunest")
  .setVersion("1.0.0")
  .build();
const document = SwaggerModule.createDocument(app, swaggerConfig);
SwaggerModule.setup("docs", app, document);

app.enableShutdownHooks();
const port = Number(Bun.env.PORT ?? 3000);
await app.listen(port);
console.log(`Listening on ${app.getUrl()} (Swagger UI: ${app.getUrl()}/docs)`);
```

Run in watch mode:

```bash
bun --watch src/main.ts
# Or with CLI:
bunx @bunest/cli dev
```

Try it with `curl`:

```bash
# Valid POST -> 201 Created
curl -i -X POST http://localhost:3000/users \
  -H "Content-Type: application/json" \
  -d '{"email":"ada@bunest.dev","name":"Ada"}'

# Invalid POST (extra field + bad email) -> 400 Bad Request with normalized details[]
curl -i -X POST http://localhost:3000/users \
  -H "Content-Type: application/json" \
  -d '{"email":"not-an-email","name":"A","extra":true}'

# OpenAPI 3.1 JSON spec
curl http://localhost:3000/docs-json
```

---

## Step 7: Write an In-Memory E2E Test (`test/users.e2e.spec.ts`)

`@bunest/testing` runs directly against `app.fetch()` with zero open ports—or against live `app.listen(0)` when needed:

```ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ValidationPipe, type BunestApplication } from "@bunest/core";
import { Test, request } from "@bunest/testing";
import { AppModule } from "../src/app.module";

describe("Users CRUD E2E", () => {
  let app: BunestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createBunestApplication();
    app.useGlobalPipes(new ValidationPipe());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("creates, fetches, updates, and deletes a user", async () => {
    const created = await request(app)
      .post("/users")
      .send({ email: "ada@bunest.dev", name: "Ada", age: 28 })
      .expect(201);

    expect(created.body.id).toBe("u_1");

    await request(app).get("/users/u_1").expect(200);

    await request(app)
      .patch("/users/u_1")
      .send({ name: "Ada Lovelace" })
      .expect(200);

    await request(app).delete("/users/u_1").expect(204);
    await request(app).get("/users/u_1").expect(404);
  });

  it("rejects invalid DTOs with normalized HTTP 400 details", async () => {
    const res = await request(app)
      .post("/users")
      .send({ email: "bad", name: "A", unexpected: 123 })
      .expect(400);

    expect(res.body.statusCode).toBe(400);
    expect(res.body.message).toBe("Validation failed");
    expect(Array.isArray(res.body.details)).toBe(true);
  });
});
```

Run tests and typecheck:

```bash
bun test
bun check
```

---

## Next Steps

- [Architecture Guide](./architecture.md) — Understand the compile-at-bootstrap pipeline, hybrid router, and DI graph.
- [Testing Guide](./testing.md) — Provider/enhancer overrides, `ModuleMocker`, SSE helpers, and `CapturingLogger`.
- [Security Guide](./security.md) — JWT auth, argon2id passwords, rate limiting, CORS, and storage hardening.
- [NestJS Migration Guide](./nestjs-migration.md) — Side-by-side comparison and full feature parity matrix.
- [Runnable Examples](../examples/) — `hello-world`, `rest-crud`, `auth-jwt-sqlite`, `websocket-chat`, and `distributed-worker`.
