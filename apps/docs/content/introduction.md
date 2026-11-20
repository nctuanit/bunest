# Introduction

**Bunest** is a progressive TypeScript framework for building fast, modular, maintainable server-side applications directly on **Bun**.

@@component(hero-cards)

## Philosophy

In the Bun ecosystem, developers often face a trade-off: raw `Bun.serve()` and lightweight routers deliver tremendous speed, while enterprise applications need an out-of-the-box architecture for dependency injection, module encapsulation, DTO validation, guards, interceptors, centralized error handling, persistence, security, messaging, AI, and observability.

**Bunest bridges both worlds.** It brings the proven **NestJS v12 architectural model**—`@Module()`, `@Controller()`, `@Injectable()`, parameter decorators, guards, pipes, interceptors, exception filters, and a complete **53-package ecosystem**—directly onto Bun's native runtime without Express, Fastify, Node HTTP shims, or mandatory RxJS overhead.

> info **Architectural Contract** Bunest is **Bun-only** (`Bun >= 1.4.3`, [ADR-001](/architecture/adrs)). Core packages operate directly on Web Standards (`Request`, `Response`, `Headers`, `ReadableStream`, `Blob`, WebCrypto) and native Bun primitives (`Bun.serve`, `Bun.file`, `Bun.password`, `bun:sqlite`, `Bun.SQL`, `bun:test`, `Bun.build`).

## A Quick Taste

If you have used NestJS before, Bunest feels immediately familiar—yet every route compiles once at bootstrap into native `Bun.serve({ routes })` closures with **zero per-request reflection**:

@@filename(users.controller.ts)
```ts
import { Body, Controller, Get, Param, Post, Query } from "@bunest/core";
import { CreateUserDto } from "./create-user.dto";
import { UsersService } from "./users.service";

@Controller("/users")
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get(":id")
  findOne(@Param("id") id: string) {
    return this.users.findOne(id);
  }

  @Post()
  create(@Body() dto: CreateUserDto, @Query("notify") notify?: string) {
    return this.users.create(dto, notify === "true");
  }
}
```

And with **Service-Layer AOP & Declarative Repositories** ([ADR-014](/architecture/adrs)), cross-cutting concerns on `@Injectable()` services require zero boilerplate:

@@filename(billing.service.ts)
```ts
import { Injectable } from "@bunest/core";
import { Cacheable, CacheEvict } from "@bunest/cache";
import { EmitEvent } from "@bunest/events";
import { WithLock } from "@bunest/locks";
import { Span, Timed } from "@bunest/observability";
import { Retry } from "@bunest/resilience";
import { Transactional } from "@bunest/sqlite";

@Injectable()
export class BillingService {
  constructor(private readonly users: UserRepository) {}

  @Span("users.lookup")
  @Cacheable({ key: (email: string) => `user:${email}`, ttl: 60_000 })
  findByEmail(email: string) {
    return this.users.findByEmail(email);
  }

  @Timed("users.provision")
  @WithLock((email: string) => `provision:${email}`, { ttl: 5_000 })
  @Transactional()
  @CacheEvict({ key: (email: string) => `user:${email}` })
  @EmitEvent("user.provisioned", { async: true })
  @Retry({ maxAttempts: 3 })
  async provision(email: string, role: string) {
    return this.users.save({ email, role, active: true });
  }
}
```

## Core Design Principles

1. **Bun-native runtime** — No `express`, `fastify`, or `node:http` adapters in core. Zero-copy `Bun.file()`, native `Response` passthrough, and `Bun.serve({ routes })` Zig routing out of the box.
2. **Legacy TypeScript decorators** — Uses `experimentalDecorators: true` and `emitDecoratorMetadata: true` so constructor DI, parameter decorators, and `class-validator` + `class-transformer` work seamlessly without custom AST plugins.
3. **Compile-at-bootstrap execution** — Module scanning, DI graph validation, route collision detection, scope-leak detection, declarative repository SQL compilation, and execution plan compilation run **once at startup**. Hot paths perform zero `Reflect.getMetadata()` calls.
4. **Strict fail-fast guarantees** — Duplicate routes (even renamed params like `/users/:id` vs `/users/:userId`), missing providers, ambiguous exports, dependency cycles, and singleton-to-request scope leaks all fail fast before `Bun.serve()` binds a port.
5. **Secure defaults** — `ValidationPipe` defaults to `whitelist: true`, `forbidNonWhitelisted: true`, `forbidUnknownValues: true`, prototype-pollution rejection, Fetch-Metadata CSRF, Helmet-8 headers, WebCrypto JWT/JWKS, and a normalized JSON error envelope that never leaks stack traces in production.
6. **Complete 53-package ecosystem** — From core HTTP/DI/validation to SQLite/SQL/ORMs, GraphQL/Apollo, WebSockets, Microservices, CQRS, Queues, Workflows, Outbox, Webhooks, Resilience, Locks, Idempotency, Authentication/Authorization, AI/MCP, and Observability—with **48/53 packages having zero external npm runtime dependencies**.

## Prerequisites

- **Bun** `>= 1.4.3` installed on your machine
- **TypeScript** with legacy decorator emission enabled (`experimentalDecorators` + `emitDecoratorMetadata`)

Ready to build your first Bunest application? Head straight to [First steps](/overview/first-steps) or explore all 53 packages in [Packages & Monorepo](/ecosystem/packages).
