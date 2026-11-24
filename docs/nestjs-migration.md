# NestJS to Bunest Migration Guide

Bunest preserves the core NestJS mental model (`@Module`, `@Controller`, `@Injectable`, constructor DI, guards, pipes, interceptors, exception filters, `TestingModule`) across **19 consolidated, zero-dep Bun-native workspace packages** ([ADR-016](./adr/ADR-016.md), [ADR-017](./adr/ADR-017.md)) while running natively on **Bun >= 1.4.5** with Web Standards (`Request`/`Response`), Promise-based interceptors, zero-overhead service-layer AOP decorators, unified Bun-native `@bunest/orm`, and zero Express/Fastify/Node HTTP/RxJS dependencies in core.

---

## 1. Side-by-Side Comparison

### Imports & Bootstrap (35-Package Unified Mapping)

Every official NestJS v12 capability maps directly to its canonical `@bunest/*` package without redundant thin facade packages—including **unified Bun-native `@bunest/orm`** (covering 12 dialects and `./store`/`./postgres`/`./mysql`/`./testing` subpaths):

| NestJS                                                                                                   | Bunest                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `import { Controller, Get, Injectable, Module, Scope } from "@nestjs/common";`                           | `import { Controller, Get, Injectable, Module, Scope } from "@bunest/core";` _(or `@bunest/common` — **218/218 = 100.0%** export parity, `Scope.DEFAULT` alias included!)_                                                                                      |
| `import { NestFactory, AbstractHttpAdapter, HttpAdapterHost, BaseExceptionFilter } from "@nestjs/core";` | `import { NestFactory, AbstractHttpAdapter, HttpAdapterHost, BaseExceptionFilter } from "@bunest/core";` _(**54/54 = 100.0%** export parity, Bun-native `AbstractHttpAdapter` extended by `BunHttpAdapter`)_                                                    |
| `import { PartialType, PickType, OmitType } from "@nestjs/mapped-types";`                                | `import { PartialType, PickType, OmitType } from "@bunest/validation";` _(or `@bunest/core` / `@bunest/common`)_                                                                                                                                                |
| `import { ServeStaticModule } from "@nestjs/serve-static";`                                              | `import { ServeStaticModule } from "@bunest/http";` _(or `@bunest/core`, backed natively by `Bun.file()`)_                                                                                                                                                      |
| `import { JwtModule, JwtService } from "@nestjs/jwt";`                                                   | `import { JwtModule, JwtService } from "@bunest/security";` _(native WebCrypto JWT)_                                                                                                                                                                            |
| `import { ThrottlerModule, ThrottlerGuard } from "@nestjs/throttler";`                                   | `import { ThrottlerModule, ThrottlerGuard } from "@bunest/security";`                                                                                                                                                                                           |
| `import { AuthGuard, PassportModule } from "@nestjs/passport";`                                          | `import { AuthGuard, PassportModule } from "@bunest/security";`                                                                                                                                                                                                 |
| `import { TerminusModule, HealthCheckService } from "@nestjs/terminus";`                                 | `import { TerminusModule, HealthCheckService } from "@bunest/observability";` _(plus `OrmHealthIndicator`)_                                                                                                                                                     |
| `import { DevtoolsModule } from "@nestjs/devtools-integration";`                                         | `import { DevtoolsModule } from "@bunest/observability";`                                                                                                                                                                                                       |
| `import { BullModule } from "@nestjs/bullmq";` / `"@nestjs/bull"`                                        | `import { BullModule, QueueModule, WorkerHost } from "@bunest/queues";`                                                                                                                                                                                         |
| `import { TypeOrmModule, InjectRepository } from "@nestjs/typeorm";`                                     | `import { OrmModule, InjectRepository, Repository, CrudRepository, OrmRepository } from "@bunest/orm";` _(unified circular-safe Bun-native ORM covering 12 dialects over `bun:sqlite`, `Bun.SQL`, `fetch()`, & `Bun.connect()`)_                              |
| `import { MongooseModule, Schema, Prop } from "@nestjs/mongoose";`                                       | `import { OrmModule, Entity, ObjectIdColumn, MongoRepository } from "@bunest/orm";` _(native MongoDB `Bun.connect()` `OP_MSG` + BSON wire protocol or embedded local store)_                                                                                   |
| `import { SequelizeModule } / "@nestjs/drizzle" / Prisma`                                                | `import { OrmModule, DataSource, OrmRepository, CrudRepository, Transactional } from "@bunest/orm";` _(plus `@bunest/orm/store`, `./postgres`, `./mysql`, `./testing` for versioned SQL stores)_                                                              |
| `import { ApolloDriver, ApolloFederationDriver } from "@nestjs/apollo";`                                 | `import { ApolloDriver, ApolloFederationDriver, ApolloGatewayDriver } from "@bunest/apollo";` _(**20/20 = 100%** parity)_                                                                                                                                       |
| `import { ElasticsearchModule, ElasticsearchService } from "@nestjs/elasticsearch";`                     | `import { ElasticsearchModule, ElasticsearchService } from "@bunest/elasticsearch";` _(**5/5 = 100%**, native `fetch()` REST client)_                                                                                                                           |
| `import { HttpModule, HttpService } from "@nestjs/axios";`                                               | `import { HttpClientModule, HttpClient } from "@bunest/http-client";` _(**34/34**, zero-dep native `fetch()` with retries, timeouts, and interceptors)_                                                                                                         |
| `import { AiModule } from "@nestjs/ai";` / `"@nestjs/mcp"` / `"@nestjs/workflows"`                       | `import { AiModule } from "@bunest/ai";` / `"@bunest/mcp"` / `"@bunest/workflows"` _(plus `i18n`, `mail`, `storage`, `authentication`, `authorization`, `resilience`, `locks`, `idempotency`, `outbox`, `webhooks`, and `@bunest/orm/store`)_ |
| `const app = await NestFactory.create(AppModule);`                                                       | `const app = await NestFactory.create(AppModule);` _(or `BunestFactory.create(AppModule)` — supports plain `{ controllers: [...] }` shorthand too!)_                                                                                                            |
| `app.enableCsrfProtection(); app.useSecurityHeaders();`                                                  | `app.enableCsrfProtection(); app.useSecurityHeaders();` _(identical NestJS v12 built-in API)_                                                                                                                                                                   |
| `await app.listen(3000);`                                                                                | `await app.listen(3000);` _(or `await app.listen({ port: 3000 })`)_                                                                                                                                                                                             |

> **Zero-boilerplate Reflect metadata ([ADR-017](./adr/ADR-017.md)):** `@bunest/core` auto-installs a built-in, idempotent ECMAScript Reflect Metadata shim — you no longer need `reflect-metadata` in `package.json` or `import "reflect-metadata";` in entrypoints/tests (keeping it during incremental migration is also completely safe). Likewise, `@bunest/validation/validator` and `@bunest/validation/transformer` provide zero-dep drop-in replacements for `class-validator` and `class-transformer` with seamless dual-engine coexistence ([ADR-015](./adr/ADR-015.md)).

### Request & Response Handling (`Express`/`Fastify` -> Native Web `Request`/`Response`)

**NestJS (Express):**

```ts
import type { Request, Response } from "express";

@Get("download")
download(@Req() req: Request, @Res() res: Response) {
  res.setHeader("X-Custom", "1");
  res.cookie("sid", "abc", { httpOnly: true });
  return res.status(200).json({ ok: true });
}
```

**Bunest (Native Web `Request` + `ResponseContext` or `Response` Passthrough):**

```ts
import { Get, Req, Res, type ResponseContext } from "@bunest/core";

@Get("download")
download(@Req() req: Request, @Res() res: ResponseContext) {
  res.header("X-Custom", "1");
  res.cookie("sid", "abc", { httpOnly: true });
  return { ok: true }; // Still serialized normally — no `{ passthrough: true }` boilerplate!
}

@Get("stream")
streamFile() {
  // Returning a native Response, BunFile, Blob, or ReadableStream passes straight through (ADR-010)
  return new Response(Bun.file("./report.pdf"), {
    headers: { "Content-Type": "application/pdf" },
  });
}
```

### Interceptors (`RxJS Observable` -> Native `Promise` Onion)

Bunest drops mandatory RxJS from core. `CallHandler.handle()` returns a native `Promise<T>`:

**NestJS (RxJS):**

```ts
import { map } from "rxjs/operators";

@Injectable()
export class TimingInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler) {
    const start = performance.now();
    return next
      .handle()
      .pipe(map((data) => ({ data, durationMs: performance.now() - start })));
  }
}
```

**Bunest (Async/Await Onion — [ADR-008](./adr/ADR-008.md)):**

```ts
import {
  Injectable,
  type BunestInterceptor,
  type CallHandler,
  type ExecutionContext,
} from "@bunest/core";

@Injectable()
export class TimingInterceptor implements BunestInterceptor {
  async intercept(ctx: ExecutionContext, next: CallHandler) {
    const start = performance.now();
    const data = await next.handle();
    return { data, durationMs: performance.now() - start };
  }
}
```

### Service-Layer AOP & Declarative Decorators (Beyond NestJS Boilerplate — [ADR-014](./adr/ADR-014.md))

When migrating from NestJS, you can also simplify imperative service code, `BunestModule.configure()` middleware wiring, and inline SQL using Bunest's zero-overhead `MethodAspectWeaver` (`createMethodAspectDecorator`):

- **Controller/Method Middleware without `configure(consumer)`:** Decorate controllers or route handlers directly with `@UseMiddleware(SecurityHeadersMiddleware)` (`@bunest/common`). Overridden subclass methods automatically inherit parent enhancers unless opted out with `@InheritMethodEnhancers(false)`.
- **One-Line Security Wiring:** Replace `JwtModule.register(...)` + `ThrottlerModule.forRoot(...)` + multiple `APP_GUARD` providers with `SecurityModule.forRoot({ jwt, throttler, globalGuards: true, securityHeaders: true })` and composite `@Auth("admin")` / `@Protected({ roles, guards, policies })` (`@bunest/security`).
- **Declarative Transactions & Spring Data-Style Repositories:** Use `@Transactional()` and `@OrmRepository(Entity) abstract class MyRepo extends CrudRepository<Entity, number>` (with compiled-once derived `findByEmail`, `findAllByRoleAndActiveOrderByIdDesc`, `@Query`, `@Modifying`, `@SqlParam` via `OrmModule.forFeature([MyRepo])`) in `@bunest/orm` across all SQL dialects (`sqlite`, `postgres`, `mysql`, `mariadb`, `libsql`, `d1`).
- **Cross-Cutting Service Method Aspects (work on `@Injectable()` services across `SINGLETON`, `TRANSIENT`, and `REQUEST` scopes):**
  - `@Cacheable`, `@CacheEvict`, `@CachePut` (`@bunest/cache`)
  - `@Span` / `@Trace`, `@Timed`, `@Counted`, `ObservabilityModule.forRoot()` (`@bunest/observability`)
  - `@EmitEvent`, `@EventPayload` (`@bunest/events`)
  - `@Retry`, `@Timeout`, `@CircuitBreaker`, `@Bulkhead`, `@Fallback`, `@Resilience` (`@bunest/resilience` — never double-wraps HTTP/GQL/WS/RPC entrypoints!)
  - `@WithLock` (`@bunest/locks`), `@WithCls` (`@bunest/core`), `@InjectConfig` & `@ConfigValue` (`@bunest/config`)

### Testing (`supertest` -> `@bunest/testing`)

**NestJS:**

```ts
import * as request from "supertest";
const app = moduleRef.createNestApplication();
await app.init();
await request(app.getHttpServer()).get("/users").expect(200);
```

**Bunest (`request(app)` or `TestClient` — zero socket needed):**

```ts
import { Test, request } from "@bunest/testing";

const app = moduleRef.createBunestApplication(); // `createNestApplication()` alias also exists!
await app.init();
await request(app).get("/users").expect(200);
// Or typed native TestClient:
const client = moduleRef.createTestClient(app);
const res = await client.get("/users");
res.expectStatus(200);
```

### Key Behavioral Differences to Know Upfront

1. **Strict `ValidationPipe` defaults ([ADR-009](./adr/ADR-009.md)):**
   - Bunest defaults `whitelist: true`, `forbidNonWhitelisted: true`, `forbidUnknownValues: true`, `transform: true`, and `transformOptions: { enableImplicitConversion: false }`.
   - If migrating a NestJS app that expects unknown JSON keys to be silently ignored, pass `new ValidationPipe({ forbidNonWhitelisted: false })`.
   - For numeric/boolean query DTO fields, use explicit `@Type(() => Number)` or `ParseIntPipe`/`ParseBoolPipe` (never rely on JS `Boolean("false") === true`).
2. **Fail-fast Request-Scoped DI ([ADR-012](./adr/ADR-012.md)):**
   - NestJS silently bubbles `Scope.REQUEST` upward to every injecting singleton.
   - Bunest **fails fast at bootstrap** with `ScopeLeakException` showing the exact chain if a `Scope.SINGLETON` depends on a `Scope.REQUEST` provider. Explicitly mark consuming services/controllers with `{ scope: Scope.REQUEST }`, use `ClsService`/`@WithCls()`, or read ambient `getCurrentRequestContext()`.
3. **Ambiguous Multi-Module Exports ([ADR-007](./adr/ADR-007.md)):**
   - Importing two modules that both export the same token without a local override fails fast with `AmbiguousProviderException` instead of silently picking "last import wins."
4. **Exception Filter Error Envelope ([ADR-009](./adr/ADR-009.md)):**
   - Validation errors return `{ statusCode: 400, error: "Bad Request", message: "Validation failed", details: [{ field, constraints, messages }], timestamp, path }` rather than a flat `message: string[]`. Pass `errorFormat: "list"` or a custom `exceptionFactory` if legacy clients require the NestJS `message: string[]` format.

---

## 2. Comprehensive Feature Parity Matrix (35 Unified Packages)

> **Verified 35-Package Unified Bun-Native Ecosystem & AOP Milestones ([ADR-013](./adr/ADR-013.md), [ADR-014](./adr/ADR-014.md)):**
>
> - **Core, DX, Security, Realtime, Distributed & Observability (18 packages):** Includes `ServeStaticModule` in `@bunest/http`, mapped DTO types in `@bunest/validation`/`@bunest/common`, `JwtModule`/`PassportModule`/`ThrottlerModule` in `@bunest/security`, `BullModule`/`BullMQModule` in `@bunest/queues`, and `TerminusModule`/`HealthModule`/`DevtoolsModule` in `@bunest/observability`.
> - **Ecosystem & Enterprise Packages (17 packages):** Includes unified Bun-native `@bunest/orm` (12 dialects, declarative `@OrmRepository`/`CrudRepository`, `@Transactional`, `OrmMigrationRunner`, and `./store`/`./postgres`/`./mysql`/`./testing` subpaths) plus 16 Tier-1/Tier-2 packages.
> - **Release Gate:** **35 packages**, **0 runtime cycles**, **0 type-only cycles**, **0 cross-package DAG cycles**, **29/35** packages zero external runtime deps.

| Category                                 | Feature                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Status                        | Notes / Differences                                                                                                                                                                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Core & DI**                            | `@Module`, `@Global`, `DynamicModule`, re-exports, `forwardRef`, `applyDecorators()`                                                                                                                                                                                                                                                                                                                                                                                                                            | **Supported**                 | Strict encapsulation + fail-fast `AmbiguousProviderException` ([ADR-007](./adr/ADR-007.md))                                                                                                                                          |
| **Core & DI**                            | `Scope.SINGLETON`, `Scope.TRANSIENT`, `Scope.REQUEST` + Durable DI sub-trees (`durable: true`, `ContextIdFactory.apply`)                                                                                                                                                                                                                                                                                                                                                                                        | **Supported**                 | `Scope.REQUEST` via `AsyncLocalStorage`; single-flight durable tenant sub-trees; fail-fast `ScopeLeakException` ([ADR-012](./adr/ADR-012.md))                                                                                        |
| **Core & DI**                            | `DiscoveryService`, `MetadataScanner`, `ConfigurableModuleBuilder`, `LazyModuleLoader`, `RouterModule`, `ClsModule` + `@WithCls()`                                                                                                                                                                                                                                                                                                                                                                              | **Supported**                 | Built-in `DiscoveryService` & `MetadataScanner`; hierarchical `RouterModule.register()`; lazy loading with `app.close()` teardown                                                                                                    |
| **Core & DI**                            | `AbstractHttpAdapter`, `INQUIRER`, `HttpAdapterHost`, `BaseExceptionFilter`, `ApplicationConfig`, `ModulesContainer`, `ExternalContextCreator`, `GraphInspector`, `SerializedGraph`, `PartialGraphHost`, `preview`, `repl()`                                                                                                                                                                                                                                                                                    | **Supported**                 | **100.0%** `@nestjs/common@12.5.1` (**218/218**) & `@nestjs/core@12.5.1` (**54/54**, including Bun-native `AbstractHttpAdapter`) ([ADR-013](./adr/ADR-013.md))                                                                       |
| **Service AOP**                          | `createMethodAspectDecorator`, zero-overhead `DIContainer` `MethodAspectWeaver`, `@UseMiddleware`, `@InheritMethodEnhancers`, `@Transactional`, `@OrmRepository` + `CrudRepository`, `@Cacheable`/`@CacheEvict`/`@CachePut`, `@Span`/`@Trace`/`@Timed`/`@Counted`, `@EmitEvent`/`@EventPayload`, `@Auth`/`@Protected`/`SecurityModule.forRoot`, `@InjectConfig`/`@ConfigValue`, `@WithLock`, service-level `@Retry`/`@CircuitBreaker`/`@Timeout`/`@Bulkhead`/`@Fallback` | **Supported (Bunest Native)** | **Zero overhead** on undecorated classes (O(1) `WeakMap` skip), sync preservation, all DI scopes, compiled-once parameterized repositories ([ADR-014](./adr/ADR-014.md))                                                             |
| **HTTP Routing**                         | `@Controller`, all 18 HTTP/WebDAV decorators, `@Sse`, API Versioning (`URI`/`HEADER`/`MEDIA_TYPE`/`CUSTOM`), `@RawBody()`, `@SignedCookies()`, `@Render()`, `StreamableFile`, `ServeStaticModule` (`@bunest/http`), `useStaticAssets()`, streaming multipart, `CompressionMiddleware`                                                                                                                                                                                                                            | **Supported**                 | Compiled at bootstrap into `Bun.serve({ routes })` + `FallbackRadixRouter` ([ADR-011](./adr/ADR-011.md)); `BunHttpAdapter` extends Bun-native `AbstractHttpAdapter` (`58/58`, `HttpServer` `52/52`)                                  |
| **HTTP Security**                        | `app.enableCsrfProtection()`, `app.useSecurityHeaders()`, `cookies: { secret }`, `routeResolutionStrategy`, `return503OnClosing`                                                                                                                                                                                                                                                                                                                                                                                | **Supported**                 | NestJS v12 Fetch-Metadata CSRF, Helmet-8 headers, HMAC-SHA256 signed cookies with rotation, zero hot-path overhead when disabled                                                                                                     |
| **Pipeline**                             | Middleware (`BunestMiddleware`, `@UseMiddleware`), Guards, Pipes, Exception Filters, Interceptors                                                                                                                                                                                                                                                                                                                                                                                                               | **Supported (Diff on RxJS)**  | Exact 11-stage order ([ADR-008](./adr/ADR-008.md)); Promise-based `CallHandler.handle(): Promise<T>` instead of RxJS `Observable`                                                                                                    |
| **Validation & DTOs**                    | `ValidationPipe`, `ClassSerializerInterceptor`, `StandardSchemaValidationPipe`, `StandardSchemaSerializerInterceptor`, `Parse*Pipe` (`ParseDatePipe`, `ParseFilePipe` w/ magic-byte sniffing), mapped DTO helpers (`PartialType`/`PickType`/`OmitType`/`IntersectionType`)                                                                                                                                                                                                                                      | **Supported**                 | **17/17 (100.0%)** exports; stricter security defaults ([ADR-009](./adr/ADR-009.md)); `errorFormat: "bunest" \| "list" \| "grouped"`; `BODY_SANITIZED_SYMBOL` 1-pass fast path                                                       |
| **Testing & DX**                         | `@bunest/testing` (**12/12**), `@bunest/config` (**19/19**), `@bunest/swagger` (**160/160**, OpenAPI 3.1 + Interactive Explorer + Scalar/Swagger-UI), `@bunest/cli` (**45/45**, `bunestMetadataPlugin()`), `@bunest/i18n` (**36/36**)                                                                                                                                                                                                                                                                           | **Supported**                 | `createNestApplication()`/`createNestMicroservice()`, zero-socket `request(app)` & `TestClient`, ALS locale resolution                                                                                                               |
| **Security & Identity**                  | `@bunest/security` (**57/57**: `JwtModule`, `PassportModule`, `ThrottlerModule`, `SecurityModule`), `@bunest/authentication` (**132/132**), `@bunest/authorization` (**16/16**)                                                                                                                                                                                                                                                                                                                                 | **Supported**                 | Pure WebCrypto JWT/JWKS, OAuth2/OIDC PKCE, sessions, refresh-token families, TOTP MFA, magic links, API keys, `@Policy()`/`@Can()`, `SecurityModule.forRoot()`, `@Auth()`/`@Protected()`, Argon2id; zero Passport/Express dependency |
| **Database, ORM & Search**               | `@bunest/orm` (`.`, `./plugin`, `./store`, `./postgres`, `./mysql`, `./testing`), `@bunest/elasticsearch` (**5/5**)                                                                                                                                                                                                                                  | **Supported**                 | Unified zero-dep Bun-native ORM covering 12 dialects over `bun:sqlite`, `Bun.SQL`, `fetch()`, & `Bun.connect()`, Spring Data-style compiled-once `@OrmRepository`/`CrudRepository` + `@Transactional()`, `OrmMigrationRunner`, and SQL Store Kit subpaths |
| **HTTP Client, Mail & Storage**          | `@bunest/http-client` (**34/34**), `@bunest/mail` (**67/67**), `@bunest/storage` (**59/59**)                                                                                                                                                                                                                                                                                                                                                                                                                    | **Supported**                 | Native `fetch()` HTTP client, SMTP/Resend/Postmark/SendGrid/SES mailers, local/memory/S3/R2/MinIO WebCrypto SigV4 storage                                                                                                            |
| **GraphQL & Apollo**                     | `@bunest/graphql` (**142/142**) & `@bunest/apollo` (**20/20**: `ApolloDriver`, `ApolloFederationDriver`, `ApolloGatewayDriver`)                                                                                                                                                                                                                                                                                                                                                                                 | **Supported**                 | Code-first & schema-first over `graphql`, `graphql-ws` & SSE subscriptions, Federation v2 Subgraph & Multi-Subgraph Gateway, `@UseFilters`, `BunestDataLoader`                                                                       |
| **Real-Time & Microservices**            | `@bunest/websockets` (**19/19 ADR**), `@bunest/microservices` (**144/144 ADR**: TCP, InMemory, gRPC, Kafka, MQTT, Redis, NATS, RabbitMQ, hybrid `connectMicroservice`)                                                                                                                                                                                                                                                                                                                                          | **Supported**                 | Native `Bun.serve({ websocket })` + pub/sub rooms + `@Ack()` + `maxConcurrentMessages`; native TCP & gRPC + pluggable broker interfaces                                                                                              |
| **Distributed, Reliability & Workflows** | `@bunest/events` (**11/11**), `@bunest/scheduler` (**11/11**), `@bunest/cache` (**16/16**), `@bunest/queues` (**41/41**: `QueueModule`, `BullModule`/`BullMQModule`), `@bunest/cqrs` (**53/53 ADR**), `@bunest/resilience` (**51/51**), `@bunest/locks` (**39/39**), `@bunest/idempotency` (**23/23**), `@bunest/outbox` (**53/53**), `@bunest/webhooks` (**92/92** / **126/126** subpaths), `@bunest/workflows` (**127/127**)                                                                                   | **Supported**                 | Atomic Lua `RedisQueueDriver`, durable replay workflows, transactional outbox/inbox, SSRF-guarded signed webhooks, leased locks, idempotency, service + entrypoint resilience                                                        |
| **AI & Agents**                          | `@bunest/ai` (**65/65** root / **89/89** subpaths), `@bunest/mcp` (**30/30**)                                                                                                                                                                                                                                                                                                                                                                                                                                   | **Supported**                 | Native `fetch()` OpenAI/Anthropic/Gemini SSE + tools + durable agent workflows; MCP server over Streamable HTTP, SSE & stdio JSON-RPC 2.0                                                                                            |
| **Observability & Health**               | `@bunest/observability` (**38/37 ADR**: `ObservabilityModule`, `TerminusModule`/`HealthModule`, `DevtoolsModule`)                                                                                                                                                                                                                                                                                                                                                                                               | **Supported**                 | W3C Trace Context, `@Span`/`@Trace`/`@Timed`/`@Counted`, OTLP HTTP, Prometheus metrics, Terminus health indicators (`OrmHealthIndicator`), Devtools graph                                                                            |
| **Adapters / Runtime / Decorators**      | Express/Fastify middleware, Node.js/Deno runtime, TC39 Stage 3 decorators                                                                                                                                                                                                                                                                                                                                                                                                                                       | **Out of Scope**              | Bun >= 1.4.5 only ([ADR-001](./adr/ADR-001.md), [ADR-016](./adr/ADR-016.md)); legacy TypeScript decorators only ([ADR-002](./adr/ADR-002.md)); use `BunestMiddleware` / `@UseMiddleware` & `CanActivate`                                                          |

---

## 3. Migration Checklist & Common Pitfalls

- [ ] **Check `tsconfig.json`**: Enable `"experimentalDecorators": true`, `"emitDecoratorMetadata": true`, `"verbatimModuleSyntax": true`, `"types": ["bun"]`.
- [ ] **Audit imports under `verbatimModuleSyntax: true` (Most Common Pitfall!)**:
  - **Interfaces & type aliases** MUST use `import type { MyInterface } from "./types"` — Bun's transpiler preserves value imports referenced in decorated signatures, so value-importing an interface causes a runtime `SyntaxError: Export named '...' not found`.
  - **DI services, repositories & DTO classes** MUST use regular value imports (`import { UsersService } from "./users.service"`) — using `import type` on a class erases its runtime constructor from `design:paramtypes` (emitting `Object` instead of the class!).
- [ ] **Remove `reflect-metadata` boilerplate (optional):** `@bunest/core` includes a built-in zero-dep Reflect Metadata shim ([ADR-017](./adr/ADR-017.md)); optionally switch DTO imports from `class-validator`/`class-transformer` to `@bunest/validation/validator` and `@bunest/validation/transformer` ([ADR-015](./adr/ADR-015.md)).
- [ ] **Map `@nestjs/*` imports to canonical `@bunest/*` packages** across all 35 workspace packages (e.g. `@nestjs/jwt`/`@nestjs/passport`/`@nestjs/throttler` -> `@bunest/security`, `@nestjs/serve-static` -> `@bunest/http`, `@nestjs/terminus`/`@nestjs/devtools-integration` -> `@bunest/observability`, `@nestjs/bullmq`/`@nestjs/bull` -> `@bunest/queues`, `@nestjs/mapped-types` -> `@bunest/validation`, `@nestjs/axios` -> `@bunest/http-client`, and all ORM/SQL packages -> `@bunest/orm`).
- [ ] **Convert RxJS interceptors** to `async intercept(ctx, next) { const res = await next.handle(); ... }`.
- [ ] **Replace Express `req`/`res` usage** with native Web `Request`, `@Res() res: ResponseContext`, or returning native `Response` / `Bun.file()`.
- [ ] **Verify `ValidationPipe` strictness**: Add `@Type(() => Number)` on query/nested DTOs or pass explicit `ValidationPipeOptions` (`forbidNonWhitelisted: false` / `errorFormat: "list"`) where legacy clients expect NestJS defaults.
- [ ] **Fix any `ScopeLeakException` at bootstrap** by adding `{ scope: Scope.REQUEST }` to services/controllers injecting request-scoped providers, or using `ClsService` / `@WithCls()`.
- [ ] **Adopt Declarative Service Decorators where helpful ([ADR-014](./adr/ADR-014.md))**: Replace manual transaction/span/cache/lock wrappers and `APP_GUARD` boilerplate with `@Transactional()`, `@OrmRepository` (`@bunest/orm`), `@Cacheable()`, `@Span()`, `@EmitEvent()`, `@WithLock()`, `@UseMiddleware()`, and `SecurityModule.forRoot()`.
- [ ] **Run full verification**: `bun run typecheck` and `bun test`.
