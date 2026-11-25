# Providers

Providers are the fundamental building block of Bunest's Dependency Injection (DI) system. Services, repositories, factories, helpers, and configuration clients can all be treated as providers and injected into controllers or other providers via constructor parameters.

## Creating a Service

Decorate a class with `@Injectable()` to mark it as managed by the Bunest IoC container:

@@filename(cats.service.ts)

```ts
import { Injectable, NotFoundException } from "@bunest/core";

export interface Cat {
  id: string;
  name: string;
  age: number;
}

@Injectable()
export class CatsService {
  private readonly cats = new Map<string, Cat>();

  create(cat: Cat): Cat {
    this.cats.set(cat.id, cat);
    return cat;
  }

  findAll(): Cat[] {
    return [...this.cats.values()];
  }

  findOne(id: string): Cat {
    const cat = this.cats.get(id);
    if (!cat) {
      throw new NotFoundException(`Cat #${id} not found`);
    }
    return cat;
  }
}
```

## Constructor Dependency Injection

Inject `CatsService` into `CatsController` using standard TypeScript constructor injection. Bunest reads `design:paramtypes` at bootstrap and resolves dependencies automatically:

@@filename(cats.controller.ts)

```ts
import { Body, Controller, Get, Param, Post } from "@bunest/core";
import { CatsService } from "./cats.service";
import type { Cat } from "./cats.service";

@Controller("cats")
export class CatsController {
  constructor(private readonly catsService: CatsService) {}

  @Get()
  findAll(): Cat[] {
    return this.catsService.findAll();
  }

  @Get(":id")
  findOne(@Param("id") id: string): Cat {
    return this.catsService.findOne(id);
  }

  @Post()
  create(@Body() cat: Cat): Cat {
    return this.catsService.create(cat);
  }
}
```

> info **Value Import vs `import type`** Notice that `CatsService` uses a value import (`import { CatsService }`) so TypeScript emits it into `design:paramtypes`, whereas the `Cat` interface uses `import type { Cat }` so Bun's transpiler cleanly strips it.

## Explicit Token & Optional Injection

When injecting an interface, string token, or `Symbol` token (which TypeScript erases at runtime), use `@Inject(token)`. To allow a dependency to resolve to `undefined` when not registered, combine it with `@Optional()`:

@@filename(http-client.service.ts)

```ts
import { Inject, Injectable, Optional } from "@bunest/core";

export const HTTP_OPTIONS = Symbol("HTTP_OPTIONS");

export interface HttpClientOptions {
  baseUrl: string;
  timeoutMs?: number;
}

@Injectable()
export class HttpClientService {
  constructor(
    @Optional()
    @Inject(HTTP_OPTIONS)
    private readonly options?: HttpClientOptions,
  ) {}

  getBaseUrl(): string {
    return this.options?.baseUrl ?? "http://localhost:3000";
  }
}
```

## Property-Based Injection

While constructor injection is strongly recommended, Bunest also supports property injection with `@Inject(token)` (useful when subclassing base classes with complex constructors):

@@filename(audit.service.ts)

```ts
import { Inject, Injectable, Logger } from "@bunest/core";

export const AUDIT_WRITER = Symbol("AUDIT_WRITER");

@Injectable()
export class AuditService {
  @Inject(AUDIT_WRITER)
  private readonly writer: (event: string) => void;

  private readonly logger = new Logger(AuditService.name);

  record(event: string) {
    this.logger.log(`Audit event: ${event}`);
    this.writer(event);
  }
}
```

## Registering Providers

Every provider must be registered inside a module's `providers` array so Bunest's `ModuleScanner` and `DIContainer` can discover and instantiate it at bootstrap:

@@filename(cats.module.ts)

```ts
import { Module } from "@bunest/core";
import { CatsController } from "./cats.controller";
import { CatsService } from "./cats.service";

@Module({
  controllers: [CatsController],
  providers: [CatsService],
  exports: [CatsService],
})
export class CatsModule {}
```

> warning **Fail-Fast Diagnostics** If a provider token cannot be found within the owning module's visibility scope, Bunest throws **`UnknownDependencyException`** at bootstrap—printing the requesting class, exact constructor parameter index, missing token name, and owning module name.

Need factories, aliases, or async providers? Explore [Custom providers](/fundamentals/custom-providers).
