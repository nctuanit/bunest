# Bunest

**NestJS-style backend framework built natively on Bun — consolidated 19-package (6-domain) Bun 1.4.5 native NestJS v12 ecosystem + unified `@bunest/orm`, zero-overhead service-layer AOP & Spring Data-style declarative repositories.**

Bunest brings the modular architecture and developer experience of NestJS (`@Module`, `@Controller`, `@Get`/`@Post`, constructor DI, parameter decorators, guards, pipes, interceptors, exception filters, `ValidationPipe`, `TestingModule`) directly onto **Bun 1.4.5's native runtime**—`Bun.serve({ routes, fetch, websocket })`, Web `Request`/`Response`, `Bun.file()`, `Bun.S3Client`, `Bun.RedisClient`, `Bun.password` (`argon2id`), `Bun.Cookie`, `Bun.CSRF`, `Bun.CryptoHasher`, `bun:sqlite`, `Bun.SQL`, `bun:test`, and `Bun.build()`—with **zero Express, Fastify, Node HTTP, or RxJS dependency in core**.

---

## Why Bunest?

- **Consolidated 19-Package, 6-Domain, 100% Zero-Dep Bun-Native Ecosystem ([ADR-016](./docs/adr/ADR-016.md), [ADR-017](./docs/adr/ADR-017.md)):** Streamlined from 37 to **19 cohesive packages** with clean ESM subpath exports (`@bunest/core/{http,config,client,ws,i18n}`, `@bunest/validation/{validator,transformer,standard-schema}`, `@bunest/security/{auth,authz,jwt,throttler}`, `@bunest/messaging/{events,cqrs,outbox,webhooks}`, `@bunest/jobs/{queues,scheduler,redis}`, `@bunest/resilience/{locks,idempotency}`, `@bunest/graphql/apollo`, `@bunest/ai/mcp`, `@bunest/observability/{tracing,metrics,health,devtools}`) — **0 circular imports**, **19/19 packages (100%) with 0 external npm runtime deps** (including zero-dep built-in Reflect metadata shim, native DTO validator/transformer per [ADR-015](./docs/adr/ADR-015.md), native TS AST engine, and native GraphQL Oct 2021 engine), **0 `node:*` imports repo-wide** across all packages, apps, examples, tests, and Bun benchmarks outside the 2 quarantined kernel adapters in `@bunest/core`, **0 RxJS**, zero redundant wrapper/facade packages.
- **Decorator-First Architecture, Service-Layer AOP & Spring Data-Style Repositories ([ADR-014](./docs/adr/ADR-014.md)):**
  - **Self-Registering `DecoratorRegistry` & Zero-Boilerplate Bootstrap:** `@Controller`, `@Injectable`, `@Entity`, and `@OrmRepository` self-register at class-evaluation time, powering `@AutoModule` / `@Module({ autoDiscover: true })`, `BunestFactory.createAuto()`, and `WeakMap`-cached decorator-time pre-indexed controller descriptors.
  - **Unified `@Entity` Single Source of Truth:** Declare `@Entity`, `@PrimaryColumn`, `@PrimaryGeneratedColumn`, `@Column`, `@Index`, `@Unique`, `@CreateDateColumn`, and `@UpdateDateColumn` once to drive `@bunest/orm` multi-dialect schema sync (`synchronize: true`), repository auto-registration (`autoRegisterRepositories: true`), automatic `ValidationPipe` enforcement, and OpenAPI 3.1 `SwaggerModule` schemas (+ `design:returntype` response auto-inference) without duplicating DTOs or SQL.
  - **Proxy-Safe & Zero-Overhead Service/Repository AOP:** `DIContainer`'s `MethodAspectWeaver` + `weaveProxyMethodAspects` (`createMethodAspectDecorator`, O(1) `WeakMap` skip on undecorated classes, sync preservation, all DI scopes + `useFactory` proxies) powers `@Transactional`, `@OrmRepository` (`CrudRepository`), `@UseMiddleware`, `@Cacheable`/`@CacheEvict`/`@CachePut`, `@Span`/`@Trace`/`@Timed`/`@Counted`, `@EmitEvent`/`@EventPayload`, `@Auth`/`@Protected`/`SecurityModule.forRoot`, `@InjectConfig`/`@ConfigValue`, `@WithLock`, `@WithCls`, and service-level `@Retry`/`@CircuitBreaker`/`@Timeout`/`@Bulkhead`/`@Fallback`.
- **Customizable Magic Architecture ([ADR-018](./docs/adr/ADR-018.md)):** Configure project-wide framework extensions from a single typed **`bunest.config.ts`** (`defineBunestConfig`) and single-pass **`createBunestPlugin()`** 5-stage `Bun.plugin` (`classMacros` auto-field registration, `autoModuleManifest` build-time expansion, `swaggerMetadata`, custom `transforms`, `ormCircularSafe`):
  - **Extensible Class Macros:** `defineClassMacro`, `defineMacroPreset`, `setGlobalMacroDefaults`, and `registerMacroFields` driving runtime, `.d.ts` typegen, VS Code Hover/CodeLens, and `bunest delombok` from one definition.
  - **Extensible Declarative Repositories (`@bunest/orm`):** `registerQueryOperator`, implicit scopes (`@RepositoryScope`, `@SoftDelete`, `@TenantScoped`, `@IgnoreScope`), `@Projection`, first-class `Page<T>` / `CursorPage<T>` pagination, and `composeRepository` fragments (`withSoftDelete`, `withCursorPagination`).
  - **AOP Phases, Pipelines & Pointcuts + Conditional `@AutoModule` (`@bunest/core`):** `AspectPhase`, `defineAspectPipeline`, `createTypedAspect` (`asyncOnly`), `AopModule.forRoot({ pointcuts })`, scoped `@AutoModule({ scan, manifest })`, and `@RegisterIf` / `@RegisterIfEnv` / `@RegisterIfMissing` / `@Profile`.
  - **Extensible CLI Typegen & Architecture Rules (`@bunest/cli`):** `defineTypegenPlugin` (plus 5 built-in ecosystem plugins: `i18n`, `jobs`, `workflows`, `authz`, `ai-tools`) and `defineDiagnosticRule` (`BUNEST_ARCH001`, `BUNEST_ARCH002`).
- **Compile-at-bootstrap, 98.7%–101.3% of Raw `Bun.serve`:** Module scanning, DI cycle/scope-leak checks, path normalization, parameter extractors, and middleware/enhancer chains compile into native `Bun.serve({ routes })` closures once at startup—reaching **34,648 req/s** static GET (**98.7%**), **33,968 req/s** param GET + DI (**99.4%**), and **12,986 req/s** validated POST (**101.3%** of raw `Bun.serve`).
- **Secure by default:** Strict `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `forbidUnknownValues`, prototype-pollution stripping), body size limits, Fetch-Metadata CSRF, Helmet-8 security headers, production stack-trace redaction, WebCrypto JWT/JWKS algorithm pinning, `argon2id` password hashing, SSRF-guarded webhooks, parameterized declarative repositories, and NTFS-safe file storage.
- **Native Web Standards:** Direct `Response`, `BunFile`, `Blob`, `ReadableStream`, and W3C SSE passthrough without response wrappers or mandatory RxJS.

---

## Requirements

- **Bun >= 1.4.5** (`bun --version`)
- TypeScript `tsconfig.json` with legacy decorators enabled ([ADR-002](./docs/adr/ADR-002.md)):
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
- **Zero-boilerplate Reflect metadata:** `@bunest/core` includes a built-in, zero-dependency ECMAScript Reflect Metadata shim ([ADR-017](./docs/adr/ADR-017.md)) — no external `reflect-metadata` package or `import "reflect-metadata"` required.

---

## 60-Second Quickstart

```ts
// main.ts
import { IsEmail, IsString, MinLength } from "@bunest/validation/validator";
import {
  Body,
  BunestFactory,
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  ValidationPipe,
} from "@bunest/core";

class CreateUserDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(2)
  name!: string;
}

@Injectable()
class UsersService {
  private readonly users = new Map<
    string,
    { id: string; email: string; name: string }
  >();

  findOne(id: string) {
    const user = this.users.get(id);
    if (!user) throw new NotFoundException(`User "${id}" not found`);
    return user;
  }

  create(dto: CreateUserDto) {
    const user = {
      id: `u_${this.users.size + 1}`,
      email: dto.email,
      name: dto.name,
    };
    this.users.set(user.id, user);
    return user;
  }
}

@Controller("/users")
class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get(":id")
  findOne(@Param("id") id: string) {
    return this.users.findOne(id);
  }

  @Post()
  create(@Body() dto: CreateUserDto) {
    return this.users.create(dto); // POST defaults to HTTP 201 Created
  }
}

@Module({
  controllers: [UsersController],
  providers: [UsersService],
})
class AppModule {}

const app = await BunestFactory.create(AppModule);
app.useGlobalPipes(new ValidationPipe());
await app.listen(3000);
console.log(`Listening on ${app.getUrl()}`);
```

### Decorator-First Entities, Service/Repository AOP & Zero-Boilerplate Auto-Discovery ([ADR-014](./docs/adr/ADR-014.md))

Declare an `@Entity` once to drive `@bunest/orm` `synchronize: true` DDL, `ValidationPipe` validation, and `SwaggerModule` OpenAPI 3.1 schemas (plus `design:returntype` auto-inference)—and weave AOP decorators directly onto both `@Injectable()` services and `CrudRepository` proxies with zero runtime overhead on undecorated classes:

```ts
import { BunestFactory, Injectable } from "@bunest/core";
import { Cacheable, CacheEvict } from "@bunest/cache";
import { EmitEvent } from "@bunest/messaging/events";
import { Retry } from "@bunest/resilience";
import { WithLock } from "@bunest/resilience/locks";
import { Span, Timed } from "@bunest/observability";
import {
  Column,
  CreateDateColumn,
  CrudRepository,
  Entity,
  Modifying,
  OrmModule,
  OrmRepository,
  PrimaryGeneratedColumn,
  Query,
  SqlParam,
  Transactional,
} from "@bunest/orm";

@Entity("users")
class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "text", unique: true })
  email!: string;

  @Column({ type: "text", default: "member" })
  role!: string;

  @Column({ type: "boolean", default: true })
  active!: boolean;

  @CreateDateColumn()
  createdAt!: Date;
}

@Span({ kind: "CLIENT" }) // Proxy-safe AOP woven across CRUD, derived & @Query methods!
@OrmRepository(User)
abstract class UserRepository extends CrudRepository<User, number> {
  abstract findByEmail(email: string): Promise<User | null>; // Derived SQL compiled once!
  abstract findAllByRoleAndActiveOrderByIdDesc(role: string, active: boolean): Promise<User[]>;

  @Modifying()
  @Query("UPDATE users SET active = 0 WHERE email = :email")
  abstract deactivateByEmail(@SqlParam("email") email: string): Promise<number>;
}

@Injectable()
class BillingService {
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

// Zero manual @Module boilerplate & zero manual CREATE TABLE / forFeature():
const app = await BunestFactory.createAuto({
  imports: [OrmModule.forRoot({ type: "sqlite", database: ":memory:", synchronize: true, autoRegisterRepositories: true })],
});
```

For a full walkthrough with CLI scaffolding, OpenAPI/Swagger UI, and `TestingModule` E2E tests, see the **[Quickstart Guide](./docs/quickstart.md)**.

---

## Monorepo Packages (19 Packages · 6 Domains · 0 Cycles · 0 External Deps)

Across all **19 workspace packages**, **19/19 (100%) have 0 external npm runtime dependencies** with **0 `node:*` imports repo-wide** outside the 2 quarantined kernel adapters in `@bunest/core`, **0 RxJS**, **0 circular imports**, and **Bun >= 1.4.5** native API alignment ([ADR-015](./docs/adr/ADR-015.md), [ADR-016](./docs/adr/ADR-016.md), [ADR-017](./docs/adr/ADR-017.md)).

### 1. Core & Validation (2 Packages)

| Package | Path | Subpaths | Capabilities |
| --- | --- | --- | --- |
| **`@bunest/core`** | [`packages/core`](./packages/core) | `.`, `./common`, `./http`, `./config`, `./client`, `./ws`, `./i18n` | Unified core platform: **100%** `@nestjs/common` + `@nestjs/core` v12.5.1 parity, zero-overhead `DIContainer` & `MethodAspectWeaver`, hybrid `Bun.serve({ routes, fetch, websocket, tls })` + `FallbackRadixRouter`, `Bun.Cookie` & Helmet-8 headers, `ConfigModule` (`.env` + `Bun.YAML`/`TOML`/`JSONC`), zero-dep `fetch()` HTTP client (`./client`), native WebSocket gateways (`./ws`), ALS `I18nModule` (`./i18n`), `ClsModule`, `GraphInspector`, `repl()` |
| **`@bunest/validation`** | [`packages/validation`](./packages/validation) | `.`, `./validator`, `./transformer`, `./standard-schema` | **Zero-external-dep** compile-once Bun-native DTO validator (**336/336** `class-validator` exports, ReDoS-safe, sync fast-path) & transformer (**21/21** `class-transformer` exports, prototype-pollution-immune, safe coercion), `ValidationPipe`, `ClassSerializerInterceptor`, `StandardSchemaValidationPipe`, `SchemaValidationPipe`, mapped DTO helpers, and seamless dual-engine coexistence with upstream `class-validator`/`class-transformer` |

### 2. Security (1 Package)

| Package | Path | Subpaths | Capabilities |
| --- | --- | --- | --- |
| **`@bunest/security`** | [`packages/security`](./packages/security) | `.`, `./auth`, `./authz`, `./jwt`, `./throttler`, `./testing` | Unified security & identity suite: `SecurityModule.forRoot()`, `@Auth()`/`@Protected()`, WebCrypto `JwtModule`/`JwksModule`/`OAuth2`/`Oidc` (PKCE), `PassportModule`, sessions, refresh-token families, TOTP MFA, magic links, API keys, `Bun.password` (`argon2id` default + `$scrypt$` legacy compat), `Bun.CSRF`, policy-based `@Policy()`/`@Can()` authorization (`./authz`), `ThrottlerModule` (`./throttler`), and `SecurityHeadersMiddleware` |

### 3. API & AI (3 Packages)

| Package | Path | Subpaths | Capabilities |
| --- | --- | --- | --- |
| **`@bunest/swagger`** | [`packages/swagger`](./packages/swagger) | `.` | **160/160 (100%)** OpenAPI 3.1 generator, `DocumentBuilder`, `SwaggerModule`, `@Api*` decorators, Interactive Try-It-Out UI (`Bun.escapeHTML`) + Scalar/Swagger-UI presets |
| **`@bunest/graphql`** | [`packages/graphql`](./packages/graphql) | `.`, `./apollo` | **142/142** `@nestjs/graphql` + **20/20** `@nestjs/apollo` parity: code-first & schema-first GraphQL, `ApolloDriver`, Federation v2 Subgraph & Gateway (`./apollo`), `BunestDataLoader`, SSE & `graphql-ws` subscriptions |
| **`@bunest/ai`** | [`packages/ai`](./packages/ai) | `.`, `./mcp`, `./mcp/testing`, `./workflows`, `./testing` | Native `fetch()` SSE clients for OpenAI, Anthropic & Google Gemini (`generateText`, `generateObject`, `streamText`, `@AgentFunction`, durable agent workflows) + Model Context Protocol server (`./mcp`: `@Tool`, `@Resource`, `@ResourceTemplate`, `@Prompt` over Streamable HTTP, SSE & stdio JSON-RPC 2.0) |

### 4. Data & Integrations (5 Packages)

| Package | Path | Subpaths | Capabilities |
| --- | --- | --- | --- |
| **`@bunest/orm`** | [`packages/orm`](./packages/orm) | `.`, `./plugin`, `./store`, `./postgres`, `./mysql`, `./testing` | Zero-dep Bun-native ORM & SQL toolkit covering **12 dialects** via `bun:sqlite`, `Bun.SQL` (`createBunSqlExecutor`), `fetch()`, & `Bun.connect()` (`OP_MSG` + BSON): `OrmModule`, `DataSource`, `@OrmRepository`/`CrudRepository`/`@Query`/`@Modifying`, `@Transactional` ALS savepoints, `OrmMigrationRunner`, and SQL Store Kit subpaths |
| **`@bunest/cache`** | [`packages/cache`](./packages/cache) | `.`, `./redis` | `CacheModule`, `CacheService`, `CacheInterceptor`, `@Cacheable`/`@CacheEvict`/`@CachePut`, single-flight deduplication, `MemoryCacheStore` & `RedisCacheStore` backed natively by `Bun.RedisClient` (`./redis`) |
| **`@bunest/storage`** | [`packages/storage`](./packages/storage) | `.`, `./s3`, `./local`, `./memory` | Unified storage API: `LocalDisk` (`Bun.file().slice().stream()`), `InMemoryDisk`, native `BunS3Disk` (`Bun.S3Client` / `Bun.s3`), and SigV4 `S3Disk` (`Bun.CryptoHasher` + `Bun.XML.parse`) |
| **`@bunest/mail`** | [`packages/mail`](./packages/mail) | `.`, `./smtp`, `./templates` | Typed mail classes, `Bun.escapeHTML` templates (`./templates`), native SMTP (`./smtp`), Resend, Postmark, SendGrid & Amazon SES (`Bun.CryptoHasher` SigV4) transports |
| **`@bunest/elasticsearch`** | [`packages/elasticsearch`](./packages/elasticsearch) | `.` | `@nestjs/elasticsearch` v12 parity: `ElasticsearchModule` + zero-dep native Bun `fetch()` REST client |

### 5. Distributed & Async (5 Packages)

| Package | Path | Subpaths | Capabilities |
| --- | --- | --- | --- |
| **`@bunest/messaging`** | [`packages/messaging`](./packages/messaging) | `.`, `./events`, `./cqrs`, `./outbox/*`, `./webhooks/*` | Unified eventing & reliable messaging: `EventEmitterModule`/`@OnEvent`/`@EmitEvent` (`./events`), `CqrsModule`/`CommandBus`/`QueryBus`/`EventBus`/`@Saga` (`./cqrs`), transactional outbox & inbox (`./outbox`, bins `nest-outbox`), and outbound/inbound webhooks (`./webhooks`, `Bun.dns.lookup`, `Bun.CryptoHasher`, SSRF `AddressPolicy`, AES-256-GCM sealing, bin `nest-webhooks`) |
| **`@bunest/jobs`** | [`packages/jobs`](./packages/jobs) | `.`, `./queues`, `./scheduler`, `./redis` | `QueueModule`/`BullModule`/`BullMQModule`/`@Processor`/`FlowProducer`/`MemoryQueueDriver` & atomic Lua `RedisQueueDriver` backed by `Bun.RedisClient` (`./queues`, `./redis`), plus `ScheduleModule`/`@Cron`/`@Interval`/`@Timeout` with `Bun.cron.parse` fast-path (`./scheduler`) |
| **`@bunest/resilience`** | [`packages/resilience`](./packages/resilience) | `.`, `./locks`, `./locks/testing`, `./idempotency`, `./idempotency/testing` | `@Retry`, `@Timeout`, `@CircuitBreaker`, `@Bulkhead`, `@RateLimit`, `@Fallback` (entrypoint + service-layer AOP), distributed leased locks with fencing tokens & `@WithLock()`/`@OnOneInstance()` (`./locks`), and `@Idempotent()` safe retry deduplication (`./idempotency`) |
| **`@bunest/microservices`** | [`packages/microservices`](./packages/microservices) | `.` | **144/144 ADR** parity: `@MessagePattern`/`@EventPattern`, `@GrpcMethod`, `ClientProxy`, hybrid `connectMicroservice()`, TCP, InMemory, gRPC, Kafka, MQTT, native `Bun.RedisClient` Redis, NATS & RabbitMQ |
| **`@bunest/workflows`** | [`packages/workflows`](./packages/workflows) | `.`, `./core`, `./cqrs`, `./postgres`, `./mysql`, `./testing` | Durable workflows written as plain async code with deterministic replay, signals, timers, sagas, schedules, `Bun.deflateSync`/`inflateSync` AES-GCM payload codec, SQL stores, and CLI |

### 6. DX & Ops (3 Packages)

| Package | Path | Subpaths | Capabilities |
| --- | --- | --- | --- |
| **`@bunest/observability`** | [`packages/observability`](./packages/observability) | `.`, `./tracing`, `./metrics`, `./health`, `./devtools` | `ObservabilityModule.forRoot()`, `@Span`/`@Trace`/`@Timed`/`@Counted`, W3C Trace Context + OTLP (`./tracing`), Prometheus metrics (`./metrics`), `TerminusModule`/`HealthModule` with `Bun.connect()` TCP probes & `OrmHealthIndicator` (`./health`), and `DevtoolsModule` graph with `Bun.deflateSync` (`./devtools`) |
| **`@bunest/testing`** | [`packages/testing`](./packages/testing) | `.` | `Test.createTestingModule`, overrides, `createNestApplication`, `createNestMicroservice`, `ModuleMocker`, `TestClient`, `request(app)`, `readSseEvents`, `CapturingLogger` |
| **`@bunest/cli`** | [`packages/cli`](./packages/cli) | `.`, `./analyzer` | `bunest new`, `generate`/`g`, `dev`, `start`, `build`, `check`/`doctor`, `typegen`, `delombok`, `codemod`, `add`, `upgrade`, `deploy`, `repl`, `info`, unified `createBunestPlugin()`, `defineTypegenPlugin()`, and `defineDiagnosticRule()` |

---

## CLI Quick Reference

```bash
# Scaffold a new project
bunx @bunest/cli new my-api

# Generate schematics (controller, service, module, dto, guard, pipe, interceptor, filter, middleware, endpoint, resource)
bunx @bunest/cli generate resource users
bunx @bunest/cli g co orders --no-spec

# Run dev server with Bun watch mode
bunx @bunest/cli dev --port 3000

# Bundle for production with Bun.build()
bunx @bunest/cli build --minify

# Print Bunest / Bun / OS environment details
bunx @bunest/cli info
```

---

## Measured Benchmarks

Measured directly on **Bun v1.4.3** (`win32 x64`, `AMD Ryzen 7 5800H` 16 threads, `63.36 GiB` RAM, logging disabled, 0.00% errors, post 53-package & Service-Layer AOP integration) via `bun run benchmarks/run.ts` — full methodology and tables in **[`docs/benchmarks.md`](./docs/benchmarks.md)** and **[`benchmarks/RESULTS.md`](./benchmarks/RESULTS.md)**:

| Workload                          | Live HTTP (`Bunest`) | Live HTTP (Raw `Bun.serve`) |   Relative | In-Process `fetch()` (`Bunest`) | In-Process p50 Overhead |
| --------------------------------- | -------------------: | --------------------------: | ---------: | ------------------------------: | ----------------------: |
| Static `GET /health`              |     **34,648 req/s** |                35,094 req/s |  **98.7%** |  **356,015 req/s** (`0.002 ms`) |             `+0.001 ms` |
| Param `GET /users/:id` + DI       |     **33,968 req/s** |                34,158 req/s |  **99.4%** |  **254,287 req/s** (`0.003 ms`) |             `+0.002 ms` |
| JSON `POST /users` (`@Body`)      |     **22,583 req/s** |                26,793 req/s |  **84.3%** |   **36,081 req/s** (`0.008 ms`) |             `+0.006 ms` |
| Validated `POST /users/validated` |     **12,986 req/s** |                12,814 req/s | **101.3%** |   **18,977 req/s** (`0.023 ms`) |             `+0.009 ms` |

- **Cold bootstrap:** `0.3688 ms` p50 (`1,899 ops/s`) · **Hot singleton DI (`app.get`):** `1,542,353 ops/s` (`0.0005 ms` p50) · **Hot transient DI (`app.resolve`):** `112,148 ops/s` (`0.0070 ms` p50) · **Request-scoped DI lifecycle:** `160,112 ops/s` (`0.0051 ms` p50).
- **Head-to-head vs upstream NestJS `v12.5.1`** ([`benchmarks/nestjs-comparison/RESULTS.md`](./benchmarks/nestjs-comparison/RESULTS.md), 8 isolated child processes, 384,000 requests, `0.00%` errors): Bunest outperforms `@nestjs/platform-node`, Fastify, and Express on **both Bun (`1.54x–3.25x`) and Node.js `v22.23.3` (`1.89x–10.29x`) across all 4 GET & POST workloads**, with **`296.0 ms`** cold start (`1.81x–5.20x` faster), **`55.9 MB`** idle RSS, and **`1.27 MB`** core HTTP+DI footprint (1 external npm dep).

---

## Documentation & Examples

### Guides & Architecture

- **[Quickstart Guide](./docs/quickstart.md)** — Build, document, and test a validated REST CRUD API in < 15 minutes
- **[Architecture Guide](./docs/architecture.md)** — Package DAG, bootstrap compiler, 11-stage HTTP pipeline, hybrid router, and DI scopes
- **[Bunest vs NestJS Comparison (VN)](./docs/nestjs-comparison.md)** — 35-package codebase audit, NestJS v12.5.1 architecture/parity analysis, Service-Layer AOP, and 8-target head-to-head benchmarks
- **[NestJS Migration Guide](./docs/nestjs-migration.md)** — 35-package import map, side-by-side diffs, Service-Layer AOP decorators, feature parity matrix, and common pitfalls
- **[Security Guide](./docs/security.md)** — Validation defaults, headers, CORS, JWT/argon2id, rate limiting, storage, and `trustProxy`
- **[Testing Guide](./docs/testing.md)** — `TestingModule`, overrides, `ModuleMocker`, `TestClient`/`request(app)`, SSE, and `CapturingLogger`
- **[Benchmarks](./docs/benchmarks.md)** — Full measured results, overhead breakdown, and reproduction commands
- **[RFC-001](./docs/rfcs/RFC-001-controller-routing.md)** & **[ADR-001..018](./docs/adr/README.md)** — Authoritative architectural contracts (including [ADR-014](./docs/adr/ADR-014.md) Service-Layer AOP & Declarative Repositories, [ADR-015](./docs/adr/ADR-015.md) Native DTO Engine, [ADR-016](./docs/adr/ADR-016.md) 37 → 19 Package Consolidation & Bun 1.4.5 Native APIs, [ADR-017](./docs/adr/ADR-017.md) Zero External Runtime Dependencies & 2-Adapter `node:*` Quarantine, and [ADR-018](./docs/adr/ADR-018.md) Customizable Magic Architecture)

### Runnable Examples

- [`examples/hello-world`](./examples/hello-world) — Minimal controller + DI app
- [`examples/rest-crud`](./examples/rest-crud) — Validated DTO CRUD + Swagger OpenAPI + custom exception filter
- [`examples/auth-jwt-sqlite`](./examples/auth-jwt-sqlite) — Declarative `SecurityModule.forRoot()`, `@Entity`/`@PrimaryGeneratedColumn`/`@Column` entity-mapped `UserEntity`/`TaskEntity` + `@OrmRepository`/`CrudRepository` derived & `@Query` repositories (`@bunest/orm`), `@Transactional()` commit/rollback, Argon2id passwords, JWT auth, RBAC (`@Roles`), and throttling
- [`examples/websocket-chat`](./examples/websocket-chat) — Native Bun WebSocket rooms & handshake auth
- [`examples/distributed-worker`](./examples/distributed-worker) — Declarative `@Span()`, `@EmitEvent()`, `OrderRepository` (`@bunest/orm`), and `ObservabilityModule.forRoot()` with W3C trace propagation across HTTP -> SQLite -> CQRS -> Queue worker + `/health` & `/metrics`
- [`apps/playground`](./apps/playground) — Full Decorator-First showcase (`@Entity("todos")` driving `@bunest/orm` SQLite `synchronize: true`, `ValidationPipe`, and OpenAPI 3.1 `/docs` + `design:returntype`; auto-registered `@Span`-woven `TodoRepository`; `@Transactional()` + `@Span()` service; `ObservabilityModule.forRoot()` + `/health` + `/metrics` + `/_devtools/graph`)

---

## Workspace Commands

```bash
bun install             # Install & link all 19 workspace packages
bun test                # Run full test suite
bun run typecheck       # Fast Bun native typecheck (`bun check`)
bun run build           # Build all 19 packages, docs site & VS Code extension (`Bun.build`)
bun run bench           # Run reproducible benchmark suite
bun run verify:release  # Validate publish metadata, subpath exports, DAG, cycles, 0-dep/node:* quarantine & CLI smoke test
```

---

## Known Limitations

- **Bun-only runtime (`>= 1.4.5`):** Node.js and Deno are intentionally not supported in core ([ADR-001](./docs/adr/ADR-001.md), [ADR-016](./docs/adr/ADR-016.md)).
- **Legacy TypeScript decorators only:** Requires `experimentalDecorators: true` and `emitDecoratorMetadata: true`; TC39 Stage 3 standard decorators are not used ([ADR-002](./docs/adr/ADR-002.md)).
- **`verbatimModuleSyntax: true` import discipline:** DI services, repositories, and DTO classes MUST be value-imported (never `import type`), while TypeScript interfaces and type aliases MUST use `import type` to avoid Bun single-file runtime import errors ([ADR-002](./docs/adr/ADR-002.md)).
- **No Express/Fastify/Passport drop-in middleware:** Use native `BunestMiddleware` (`@UseMiddleware()`), `CanActivate` guards, or `@bunest/security` (`./auth`, `./authz`, `./jwt`, `./throttler`) instead of Express `(req, res, next)` middleware.
- **Promise-based interceptors (no RxJS):** `CallHandler.handle()` returns `Promise<T>`, not an RxJS `Observable` ([ADR-008](./docs/adr/ADR-008.md)).
- **`design:paramtypes` erasure:** TypeScript interfaces, unions, and generic type parameters erase at runtime—use explicit `@Inject(TOKEN)`, `@Type()`, or `@ApiProperty()` where reflection cannot infer a class constructor.
- **Native Bun drivers + pluggable broker interfaces:** Redis (`@bunest/cache/redis`, `@bunest/jobs/redis`, `@bunest/microservices` `Transport.REDIS`), S3 (`@bunest/storage/s3` `BunS3Disk`), and SQL (`@bunest/orm` via `bun:sqlite` / `Bun.SQL` / `fetch()` / `Bun.connect()`) all run natively on Bun 1.4.5 with zero external deps, while NATS, RabbitMQ, Kafka, and MQTT also accept typed pluggable client interfaces.
- **Benchmarks scope:** Core numbers above compare Bunest directly against raw `Bun.serve()` ([`benchmarks/RESULTS.md`](./benchmarks/RESULTS.md)), and reproducible 8-target head-to-head benchmarks against upstream NestJS `v12.5.1` on both Bun and Node.js are published in [`benchmarks/nestjs-comparison/RESULTS.md`](./benchmarks/nestjs-comparison/RESULTS.md); comparisons against other frameworks (e.g. Elysia, Hono) are not claimed until measured under an equivalent reproducible harness.

---

## Governance & License

- [Contributing Guide](./CONTRIBUTING.md) · [Security Policy](./SECURITY.md) · [Changelog](./CHANGELOG.md) · [MIT License](./LICENSE)
