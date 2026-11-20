# Bunest

**NestJS-style backend framework built natively on Bun — complete 53-package official NestJS v12 ecosystem + zero-overhead service-layer AOP & Spring Data-style declarative repositories.**

Bunest brings the modular architecture and developer experience of NestJS (`@Module`, `@Controller`, `@Get`/`@Post`, constructor DI, parameter decorators, guards, pipes, interceptors, exception filters, `ValidationPipe`, `TestingModule`) directly onto **Bun's native runtime**—`Bun.serve({ routes, fetch, websocket })`, Web `Request`/`Response`, `Bun.file()`, `Bun.password`, `bun:sqlite`, `Bun.SQL`, `bun:test`, and `Bun.build()`—with **zero Express, Fastify, Node HTTP, or RxJS dependency in core**.

---

## Why Bunest?

- **Complete 53-Package Official NestJS v12 Ecosystem:** **22** core/ecosystem packages + **23** Tier-1 & Tier-2 ecosystem packages + **8** drop-in `@nestjs/*` migration facades = **53 workspace packages** (**1,468** source files, **100% ADR-adjusted NestJS v12 parity** across Group 1 `610/610`, Group 2 `475/474`, and Tier-1/Tier-2 `1,311/1,311` exports / `5,922/5,922` members, **6,344 pass / 0 fail**, **0 circular imports**, **48/53 packages with 0 external npm runtime deps**, **0 new external runtime deps**, **0 RxJS**).
- **Decorator-First Architecture, Service-Layer AOP & Spring Data-Style Repositories ([ADR-014](./docs/adr/ADR-014.md)):**
  - **Self-Registering `DecoratorRegistry` & Zero-Boilerplate Bootstrap:** `@Controller`, `@Injectable`, `@Entity`, `@SqliteRepository`, and `@SqlRepository` self-register at class-evaluation time, powering `@AutoModule` / `@Module({ autoDiscover: true })`, `BunestFactory.createAuto()`, and `WeakMap`-cached decorator-time pre-indexed controller descriptors.
  - **Unified `@Entity` Single Source of Truth:** Declare `@Entity`, `@PrimaryKey`, `@PrimaryGeneratedColumn`, `@Column`, `@Index`, `@Unique`, `@CreateDateColumn`, and `@UpdateDateColumn` once to drive SQLite/SQL auto-DDL (`autoSync: true`), repository auto-registration (`autoRegisterRepositories: true`), automatic `ValidationPipe` enforcement, and OpenAPI 3.1 `SwaggerModule` schemas (+ `design:returntype` response auto-inference) without duplicating DTOs or SQL.
  - **Proxy-Safe & Zero-Overhead Service/Repository AOP:** `DIContainer`'s `MethodAspectWeaver` + `weaveProxyMethodAspects` (`createMethodAspectDecorator`, O(1) `WeakMap` skip on undecorated classes, sync preservation, all DI scopes + `useFactory` proxies) powers `@Transactional`, `@SqliteRepository`/`@SqlRepository` (`JpaRepository`/`SqlCrudRepository`), `@UseMiddleware`, `@Cacheable`/`@CacheEvict`/`@CachePut`, `@Span`/`@Trace`/`@Timed`/`@Counted`, `@EmitEvent`/`@EventPayload`, `@Auth`/`@Protected`/`SecurityModule.forRoot`, `@InjectConfig`/`@ConfigValue`, `@WithLock`, `@WithCls`, and service-level `@Retry`/`@CircuitBreaker`/`@Timeout`/`@Bulkhead`/`@Fallback`.
- **Compile-at-bootstrap, 98.7%–101.3% of Raw `Bun.serve`:** Module scanning, DI cycle/scope-leak checks, path normalization, parameter extractors, and middleware/enhancer chains compile into native `Bun.serve({ routes })` closures once at startup—reaching **34,648 req/s** static GET (**98.7%**), **33,968 req/s** param GET + DI (**99.4%**), and **12,986 req/s** validated POST (**101.3%** of raw `Bun.serve`).
- **Secure by default:** Strict `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `forbidUnknownValues`, prototype-pollution stripping), body size limits, Fetch-Metadata CSRF, Helmet-8 security headers, production stack-trace redaction, WebCrypto JWT/JWKS algorithm pinning, `argon2id` password hashing, SSRF-guarded webhooks, parameterized declarative repositories, and NTFS-safe file storage.
- **Native Web Standards:** Direct `Response`, `BunFile`, `Blob`, `ReadableStream`, and W3C SSE passthrough without response wrappers or mandatory RxJS.

---

## Requirements

- **Bun >= 1.4.3** (`bun --version`)
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
- Import `"reflect-metadata"` once at line 1 of your entrypoint before loading decorated classes.

---

## 60-Second Quickstart

```ts
// main.ts
import "reflect-metadata";
import { IsEmail, IsString, MinLength } from "class-validator";
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
  private readonly users = new Map<string, { id: string; email: string; name: string }>();

  findOne(id: string) {
    const user = this.users.get(id);
    if (!user) throw new NotFoundException(`User "${id}" not found`);
    return user;
  }

  create(dto: CreateUserDto) {
    const user = { id: `u_${this.users.size + 1}`, email: dto.email, name: dto.name };
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

Declare an `@Entity` once to drive SQLite/SQL `autoSync: true` DDL, `ValidationPipe` validation, and `SwaggerModule` OpenAPI 3.1 schemas (plus `design:returntype` auto-inference)—and weave AOP decorators directly onto both `@Injectable()` services and `JpaRepository`/`SqlCrudRepository` proxies with zero runtime overhead on undecorated classes:

```ts
import { BunestFactory, Injectable } from "@bunest/core";
import { Cacheable, CacheEvict } from "@bunest/cache";
import { EmitEvent } from "@bunest/events";
import { WithLock } from "@bunest/locks";
import { Span, Timed } from "@bunest/observability";
import { Retry } from "@bunest/resilience";
import {
  Column,
  CreateDateColumn,
  Entity,
  JpaRepository,
  Modifying,
  PrimaryGeneratedColumn,
  Query,
  SqliteModule,
  SqliteRepository,
  SqlParam,
  Transactional,
} from "@bunest/sqlite";

@Entity("users")
class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "text", unique: true, minLength: 3 })
  email!: string;

  @Column({ type: "text", default: "member" })
  role!: string;

  @Column({ type: "boolean", default: true })
  active!: boolean;

  @CreateDateColumn()
  createdAt!: Date;
}

@Span({ kind: "CLIENT" }) // Proxy-safe AOP woven across CRUD, derived & @Query methods!
@SqliteRepository(User)
abstract class UserRepository extends JpaRepository<User, number> {
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
  imports: [SqliteModule.forRoot({ filename: ":memory:", autoSync: true, autoRegisterRepositories: true })],
});
```

For a full walkthrough with CLI scaffolding, OpenAPI/Swagger UI, and `TestingModule` E2E tests, see the **[Quickstart Guide](./docs/quickstart.md)**.

---

## Monorepo Packages (53 Packages — 1,468 Source Files, 0 Cycles)

Across all **53 workspace packages**, **48/53 have 0 external npm runtime dependencies**—the entire monorepo uses only 4 sanctioned external runtime dependencies (`reflect-metadata`, `class-validator`, `class-transformer`, `graphql`) with **0 RxJS** and **0 circular imports**.

### Core, DX, Security, Native Data, Realtime, Distributed & Observability (22 Packages)

| Tier | Package | Path | Description |
|---|---|---|---|
| **Core** | `@bunest/common` | [`packages/common`](./packages/common) | **218/218 (100.0%)** `@nestjs/common@12.5.1` export parity (**1,079/1,079** members): `MetadataRegistry`, `Reflector`, `createMethodAspectDecorator`, `@UseMiddleware`, `@InheritMethodEnhancers`, `ShutdownSignal`, `ConfigurableModuleBuilder`, `HttpServer` (52/52), canonical `ValidationPipe`/`StandardSchema*`/`ClassSerializerInterceptor`/`MappedTypes`, all 18 HTTP/WebDAV decorators, `@Render`, `@SignedCookies`, all 23 `HttpException` subclasses, `ConsoleLogger`, `Parse*` pipes, `StreamableFile` |
| **Core** | `@bunest/core` | [`packages/core`](./packages/core) | **54/54 (100.0%)** `@nestjs/core@12.5.1` export parity (**311/311** members): zero-overhead `DIContainer` `MethodAspectWeaver`, Bun-native `AbstractHttpAdapter`, `BunestFactory`/`NestFactory`, `INQUIRER`, `HttpAdapterHost`, `BaseExceptionFilter`, `ApplicationConfig`, `ModulesContainer`, `ExternalContextCreator` (DI param pipes), Durable DI, `DiscoveryService.createDecorator()`, `RouterModule`, `LazyModuleLoader`, `ClsModule` + `@WithCls()`, `GraphInspector`/`SerializedGraph`/`PartialGraphHost`, `preview`, `repl()` |
| **Core** | `@bunest/http` | [`packages/http`](./packages/http) | Bun-native `AbstractHttpAdapter` (58/58) & `BunHttpAdapter` (`HttpServer` 52/52), `@UseMiddleware` & subclass enhancer inheritance, Bun-native `ServeStaticModule`, hybrid `Bun.serve({ routes, tls })` + `FallbackRadixRouter`, Fetch-Metadata `enableCsrfProtection()`, Helmet-8 `useSecurityHeaders()`, HMAC-SHA256 signed cookies, `@Render()`, API Versioning, `useStaticAssets`, `CompressionMiddleware`, `rawBody` |
| **Core** | `@bunest/validation` | [`packages/validation`](./packages/validation) | **17/17 (100.0%)** exports (**73/73** members): `ValidationPipe` (`class-validator` + `class-transformer`, `errorFormat: "bunest" \| "list" \| "grouped"`), `ClassSerializerInterceptor`, `StandardSchemaValidationPipe`, `StandardSchemaSerializerInterceptor`, `SchemaValidationPipe` |
| **Core** | `@bunest/mapped-types` | [`packages/mapped-types`](./packages/mapped-types) | **10/10 (100.0%)** `@nestjs/mapped-types@12.0.1` parity: `PartialType`, `PickType`, `OmitType`, variadic `IntersectionType`, `CompositionType`, metadata inheritance helpers |
| **HTTP Client** | `@bunest/axios` | [`packages/axios`](./packages/axios) | **5/5 (100.0%)** exports (`HttpService` **12/12**, 0 external runtime deps): `@nestjs/axios`-compatible `HttpModule` & `HttpService` on native `fetch()` (`AbortSignal.timeout`, interceptors, retries, form helpers) |
| **DX** | `@bunest/testing` | [`packages/testing`](./packages/testing) | **12/12 (100.0%)** exports (**78/78** members): `Test.createTestingModule`, overrides, `createNestApplication`, `createNestMicroservice`, `ModuleMocker`, `TestClient`, `request(app)`, `readSseEvents`, `CapturingLogger` |
| **DX** | `@bunest/cli` | [`packages/cli`](./packages/cli) | **45/45 (100.0%)** exports: `bunest new`, `generate`/`g`, `dev`, `build`, `repl`, `info` CLI & `bunestMetadataPlugin()` build-time DTO metadata plugin for `Bun.build()` |
| **DX** | `@bunest/config` | [`packages/config`](./packages/config) | **19/19 (100.0%)** exports (**30/30** members): `ConfigModule`, `ConfigService`, `.env` loader with expansion, `registerAs`, DTO validation, `@InjectConfig`, `@ConfigValue`, secret redactor |
| **DX** | `@bunest/swagger` | [`packages/swagger`](./packages/swagger) | **160/160 (100.0%)** exports (**527/527** members): OpenAPI 3.1 generator, `DocumentBuilder`, `SwaggerModule`, `@Api*` decorators, Interactive Try-It-Out UI + Scalar/Swagger-UI presets |
| **Security** | `@bunest/security` | [`packages/security`](./packages/security) | **57/57 (100.0%)** exports (**179/179** members): `SecurityModule.forRoot()`, `@Auth()`, `@Protected()`, WebCrypto `JwtModule`/`JwtService`, `JwksModule`/`OAuth2Module`/`OidcModule` (PKCE), pluggable `AuthGuard`, `PasswordService` (`argon2id`), `RolesGuard`/`PoliciesGuard`, `CsrfGuard`, `ThrottlerModule`, `SecurityHeadersMiddleware`, `StorageModule` |
| **Database** | `@bunest/sqlite` | [`packages/sqlite`](./packages/sqlite) | Bun-native `bun:sqlite` (**68** exports): `SqliteModule`, `SqliteService`, `@Transactional`, Spring Data-style `@SqliteRepository`/`JpaRepository`/`@Query`/`@Modifying`/`@SqlParam` + compiled-once derived finders, ALS transactions/savepoints, `SqliteMigrationRunner`, `BaseSqliteRepository` |
| **Database** | `@bunest/sql` | [`packages/sql`](./packages/sql) | Bun-native `Bun.SQL` (**95** exports): `SqlModule`/`SqlService` (Postgres/MySQL/SQLite), `@Transactional` (SQL/Drizzle/Prisma), dialect-aware `@SqlRepository`/`SqlCrudRepository`/`@SqlQuery`/`@Modifying`/`@SqlParam` + derived finders, `SqlMigrationRunner`, `DrizzleModule` & `PrismaModule` |
| **Real-Time** | `@bunest/websockets` | [`packages/websockets`](./packages/websockets) | **19/19 ADR (100.0%)** parity: native `Bun.serve({ websocket })` gateways (`@WebSocketGateway`, `@SubscribeMessage`, `@Ack()`, `maxConcurrentMessages`, `useWebSocketAdapter()`, rooms/pub-sub, handshake auth, WS guards/pipes/filters) |
| **API** | `@bunest/graphql` | [`packages/graphql`](./packages/graphql) | **142/142 (100.0%)** `@nestjs/graphql@14.2.1` parity: code-first & schema-first GraphQL, Federation v2 Subgraph, `@UseFilters`, `BunestDataLoader`, SSE & `graphql-ws` subscriptions |
| **Distributed** | `@bunest/events` | [`packages/events`](./packages/events) | **11/11 (100.0%)** parity: `EventEmitterModule`, `@OnEvent`, `@EmitEvent`, `@EventPayload` (with pipes/guards/interceptors/filters), wildcard `*`/`**` matching, sync & `emitAsync` |
| **Distributed** | `@bunest/scheduler` | [`packages/scheduler`](./packages/scheduler) | **11/11 (100.0%)** + **83/83 `CronExpression`**: `ScheduleModule`, pure-TS 5/6-field DST-aware cron parser, `@Cron`, `@Interval`, `@Timeout`, overlap protection |
| **Distributed** | `@bunest/cache` | [`packages/cache`](./packages/cache) | **16/16 (100.0%)** parity: `CacheModule`, `CacheService`, `CacheInterceptor`, `@Cacheable`/`@CacheEvict`/`@CachePut`, `@CacheKey`/`@CacheTTL`/`@NoCache`, `MemoryCacheStore` & `RedisCacheStore` |
| **Distributed** | `@bunest/queues` | [`packages/queues`](./packages/queues) | **41/41 (100.0%)** parity: `QueueModule`, `@Processor`/`@Process`, retries/backoff/DLQ, `MemoryQueueDriver`, atomic Lua `RedisQueueDriver` (lock lease + stalled recovery), & `BullMQModule` |
| **Distributed** | `@bunest/cqrs` | [`packages/cqrs`](./packages/cqrs) | **53/53 ADR (100.0%)** parity: `CqrsModule`, `CommandBus`, `QueryBus`, `EventBus`, `AggregateRoot`, `EventPublisher`, `@Saga` |
| **Distributed** | `@bunest/microservices` | [`packages/microservices`](./packages/microservices) | **144/144 ADR (100.0%)** parity: `@MessagePattern`/`@EventPattern`, `@GrpcMethod`/`@GrpcStreamMethod`/`@GrpcStreamCall`, `*RecordBuilder`, `CustomTransportStrategy`, `PreRequestHook`, `ClientProxy`, hybrid `connectMicroservice()`, TCP, InMemory, gRPC, Kafka, MQTT, Redis, NATS & RabbitMQ |
| **Observability** | `@bunest/observability` | [`packages/observability`](./packages/observability) | **38/37 ADR (102.7%)** parity: `ObservabilityModule.forRoot()`, `@Span`/`@Trace`/`@Timed`/`@Counted`, W3C Trace Context (`TracingModule`, `OtlpHttpSpanExporter`), Prometheus `MetricsModule`, Terminus `HealthModule`, `DevtoolsModule` graph |

### Official NestJS v12 Ecosystem — Tier-1 & Tier-2 Packages (23 Packages — 1,311/1,311 Exports, 5,922/5,922 Members = 100%)

| Category | Package | Path | Parity & Capabilities |
|---|---|---|---|
| **ORM & Data** | `@bunest/typeorm` | [`packages/typeorm`](./packages/typeorm) | **19/19 (100%)** `@nestjs/typeorm` v12 parity: `TypeOrmModule`, `@InjectRepository`/`@InjectDataSource`/`@InjectEntityManager`, multi-DataSource DI lifecycle, zero-dep Bun SQLite/in-memory adapter |
| **ORM & Data** | `@bunest/mongoose` | [`packages/mongoose`](./packages/mongoose) | **25/25 (100%)** `@nestjs/mongoose` v12 parity: `MongooseModule`, `@Schema`/`@Prop`/`@InjectModel`/`@InjectConnection`, `SchemaFactory`, ObjectId pipes, zero-dep Bun-native structural driver |
| **ORM & Data** | `@bunest/sequelize` | [`packages/sequelize`](./packages/sequelize) | **12/12 (100%)** `@nestjs/sequelize` v12 parity: `SequelizeModule`, `@InjectModel`/`@InjectConnection`, multi-connection DI lifecycle, zero-dep Bun SQLite/in-memory adapter |
| **ORM & Data** | `@bunest/drizzle` | [`packages/drizzle`](./packages/drizzle) | **12/12 (100%)** `@nestjs/drizzle` parity: `DrizzleModule`, `@InjectDrizzle`, automatic client shutdown & `@bunest/sql` ALS transaction integration |
| **Search** | `@bunest/elasticsearch` | [`packages/elasticsearch`](./packages/elasticsearch) | **5/5 (100%)** `@nestjs/elasticsearch` v12 parity: `ElasticsearchModule` + full native Bun `fetch()` REST client with zero external deps |
| **GraphQL** | `@bunest/apollo` | [`packages/apollo`](./packages/apollo) | **20/20 (100%)** `@nestjs/apollo` parity: Bun-native `ApolloDriver`, `ApolloFederationDriver` (Federation v2 Subgraph), and `ApolloGatewayDriver` (multi-subgraph gateway) |
| **Queues** | `@bunest/bull` | [`packages/bull`](./packages/bull) | **53/53 (100%)** `@nestjs/bull` parity: classic `BullModule`, `@Processor`/`@Process`/`@OnQueue*` decorators & `BullExplorer` backed natively by `@bunest/queues` |
| **AI & Agents** | `@bunest/ai` | [`packages/ai`](./packages/ai) | **65/65** root (**89/89** w/ `./testing`, `./workflows`, **461/461** members = 100%): OpenAI, Anthropic & Google Gemini native `fetch()` SSE clients, `@AgentFunction`, Standard Schema `generateObject`, retries/fallbacks/budgets, durable agent workflows |
| **AI & Agents** | `@bunest/mcp` | [`packages/mcp`](./packages/mcp) | **30/30 (100%)** (incl. `./testing`): Model Context Protocol server exposing `@Tool`, `@Resource`, `@ResourceTemplate`, and `@Prompt` over native Streamable HTTP, SSE, and stdio JSON-RPC 2.0 |
| **APM & Telemetry** | `@bunest/observe` | [`packages/observe`](./packages/observe) | **49/49 (100%)** (+ CLI bin): APM agent with distributed tracing, runtime/custom metrics, SLO objectives, PII redaction, and OTLP export |
| **HTTP & I18n** | `@bunest/http-client` | [`packages/http-client`](./packages/http-client) | **34/34 (100%)**: Zero-dep native `fetch()` HTTP client with named clients, retries, timeouts, interceptors, and typed errors |
| **HTTP & I18n** | `@bunest/i18n` | [`packages/i18n`](./packages/i18n) | **36/36 (100%)**: Per-request `AsyncLocalStorage` locale resolution, typed translations, `Intl` formatting, and localized validation messages |
| **Mail & Files** | `@bunest/mail` | [`packages/mail`](./packages/mail) | **67/67 (100%)**: Typed mail classes, auto-escaped HTML templates, and native SMTP, Resend, Postmark, SendGrid & Amazon SES transports |
| **Mail & Files** | `@bunest/storage` | [`packages/storage`](./packages/storage) | **59/59 (100%)**: Unified storage API for local disks, in-memory storage, and S3/R2/MinIO with native WebCrypto SigV4 `fetch()`, streamed uploads, and signed URLs |
| **Identity** | `@bunest/authentication` | [`packages/authentication`](./packages/authentication) | **132/132 (100%)** (incl. `./testing`): Sessions, JWT/JWKS, refresh-token families, TOTP MFA, magic links, OIDC/OAuth2, API keys, Argon2id hashing, store contract testing |
| **Identity** | `@bunest/authorization` | [`packages/authorization`](./packages/authorization) | **16/16 (100%)**: Policy-based authorization with `@Policy()` classes, `@Can()` / `@Can.Anyone()` route enforcement, `AuthorizationService`, and audit events |
| **Reliability** | `@bunest/resilience` | [`packages/resilience`](./packages/resilience) | **51/51 (100%)**: Retry, timeout, circuit breaker, bulkhead, outbound rate limit & fallback — works on BOTH HTTP/GQL/WS/RPC entrypoints AND `@Injectable()` service methods (zero double-wrapping) |
| **Reliability** | `@bunest/locks` | [`packages/locks`](./packages/locks) | **39/39** root (**42/42** w/ `./testing`): Leased distributed locks with fencing tokens, `@WithLock()` service aspect, `@OnOneInstance()`, `@WithoutOverlapping()`, and leader election |
| **Reliability** | `@bunest/idempotency` | [`packages/idempotency`](./packages/idempotency) | **23/23 (100%)** (incl. `./testing`): `@Idempotent()` safe retry deduplication for HTTP routes, GraphQL mutations, and microservice handlers |
| **SQL Stores** | `@bunest/store-kit` | [`packages/store-kit`](./packages/store-kit) | **13/13 (100%)** (`.`, `./postgres`, `./mysql`, `./testing`): Foundational SQL store kit over `Bun.SQL` with versioned migrations, CLI, and contract testing |
| **Messaging** | `@bunest/outbox` | [`packages/outbox`](./packages/outbox) | **53/53 (100%)** (`.`, `./testing`, `./postgres`, `./mysql` + CLI bin): Transactional outbox, consumer inbox deduplication, leased relay, and dead-letter management |
| **Messaging** | `@bunest/webhooks` | [`packages/webhooks`](./packages/webhooks) | **92/92** root (**126/126** across `.`, `./testing`, `./postgres`, `./mysql` + CLI bin): Outbound delivery (HMAC-SHA256, SSRF `AddressPolicy`, AES-256-GCM sealing/rotation, backoff/429/410) & inbound verification (Standard Webhooks, Stripe, GitHub, custom) |
| **Workflows** | `@bunest/workflows` | [`packages/workflows`](./packages/workflows) | **127/127 (100%)** (`.`, `./testing`, `./cqrs`, `./postgres`, `./mysql`, `./core` + CLI bin): Durable workflows written as plain async code with deterministic replay, signals, timers, sagas, schedules, and SQL stores |

### Drop-In `@nestjs/*` Migration Facades (8 Packages)

Install familiar 1:1 package names while running Bunest's native zero-dependency implementations underneath:

| Facade Package | Path | Drop-In Replacement For | Backed Natively By |
|---|---|---|---|
| `@bunest/jwt` | [`packages/jwt`](./packages/jwt) | `@nestjs/jwt` v12 | `@bunest/security` (WebCrypto JWT) |
| `@bunest/throttler` | [`packages/throttler`](./packages/throttler) | `@nestjs/throttler` v6.8 | `@bunest/security` |
| `@bunest/passport` | [`packages/passport`](./packages/passport) | `@nestjs/passport` v12 | `@bunest/security` (`AuthGuard` strategies) |
| `@bunest/serve-static` | [`packages/serve-static`](./packages/serve-static) | `@nestjs/serve-static` v12 | `@bunest/http` (`Bun.file()`) |
| `@bunest/terminus` | [`packages/terminus`](./packages/terminus) | `@nestjs/terminus` v12 | `@bunest/observability` (+ zero-dep ORM health indicators) |
| `@bunest/devtools-integration` | [`packages/devtools-integration`](./packages/devtools-integration) | `@nestjs/devtools-integration` v12 | `@bunest/observability` |
| `@bunest/bullmq` | [`packages/bullmq`](./packages/bullmq) | `@nestjs/bullmq` v12 | `@bunest/queues` |
| `@bunest/prisma` | [`packages/prisma`](./packages/prisma) | Prisma NestJS integration | `@bunest/sql` (`PrismaService` + `PrismaClientExceptionFilter`) |

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

| Workload | Live HTTP (`Bunest`) | Live HTTP (Raw `Bun.serve`) | Relative | In-Process `fetch()` (`Bunest`) | In-Process p50 Overhead |
|---|---:|---:|---:|---:|---:|
| Static `GET /health` | **34,648 req/s** | 35,094 req/s | **98.7%** | **356,015 req/s** (`0.002 ms`) | `+0.001 ms` |
| Param `GET /users/:id` + DI | **33,968 req/s** | 34,158 req/s | **99.4%** | **254,287 req/s** (`0.003 ms`) | `+0.002 ms` |
| JSON `POST /users` (`@Body`) | **22,583 req/s** | 26,793 req/s | **84.3%** | **36,081 req/s** (`0.008 ms`) | `+0.006 ms` |
| Validated `POST /users/validated` | **12,986 req/s** | 12,814 req/s | **101.3%** | **18,977 req/s** (`0.023 ms`) | `+0.009 ms` |

- **Cold bootstrap:** `0.3688 ms` p50 (`1,899 ops/s`) · **Hot singleton DI (`app.get`):** `1,542,353 ops/s` (`0.0005 ms` p50) · **Hot transient DI (`app.resolve`):** `112,148 ops/s` (`0.0070 ms` p50) · **Request-scoped DI lifecycle:** `160,112 ops/s` (`0.0051 ms` p50).
- **Head-to-head vs upstream NestJS `v12.5.1`** ([`benchmarks/nestjs-comparison/RESULTS.md`](./benchmarks/nestjs-comparison/RESULTS.md), 8 isolated child processes, 384,000 requests, `0.00%` errors): Bunest outperforms `@nestjs/platform-node`, Fastify, and Express on **both Bun (`1.54x–3.25x`) and Node.js `v22.23.3` (`1.89x–10.29x`) across all 4 GET & POST workloads**, with **`296.0 ms`** cold start (`1.81x–5.20x` faster), **`55.9 MB`** idle RSS, and **`1.27 MB`** core HTTP+DI footprint (1 external npm dep).

---

## Documentation & Examples

### Guides & Architecture
- **[Quickstart Guide](./docs/quickstart.md)** — Build, document, and test a validated REST CRUD API in < 15 minutes
- **[Architecture Guide](./docs/architecture.md)** — Package DAG, bootstrap compiler, 11-stage HTTP pipeline, hybrid router, and DI scopes
- **[Bunest vs NestJS Comparison (VN)](./docs/nestjs-comparison.md)** — 53-package codebase audit, NestJS v12.5.1 architecture/parity analysis, Service-Layer AOP, and 8-target head-to-head benchmarks
- **[NestJS Migration Guide](./docs/nestjs-migration.md)** — Drop-in facade & 53-package import map, side-by-side diffs, Service-Layer AOP decorators, feature parity matrix, and common pitfalls
- **[Security Guide](./docs/security.md)** — Validation defaults, headers, CORS, JWT/argon2id, rate limiting, storage, and `trustProxy`
- **[Testing Guide](./docs/testing.md)** — `TestingModule`, overrides, `ModuleMocker`, `TestClient`/`request(app)`, SSE, and `CapturingLogger`
- **[Benchmarks](./docs/benchmarks.md)** — Full measured results, overhead breakdown, and reproduction commands
- **[RFC-001](./docs/rfcs/RFC-001-controller-routing.md)** & **[ADR-001..014](./docs/adr/README.md)** — Authoritative architectural contracts (including [ADR-014](./docs/adr/ADR-014.md) Service-Layer Method Aspect Weaving & Declarative Repositories)

### Runnable Examples
- [`examples/hello-world`](./examples/hello-world) — Minimal controller + DI app
- [`examples/rest-crud`](./examples/rest-crud) — Validated DTO CRUD + Swagger OpenAPI + custom exception filter
- [`examples/auth-jwt-sqlite`](./examples/auth-jwt-sqlite) — Declarative `SecurityModule.forRoot()`, `@Entity`/`@PrimaryGeneratedColumn`/`@Column` entity-mapped `UserEntity`/`TaskEntity` + `@SqliteRepository`/`JpaRepository` derived & `@Query` repositories, `@Transactional()` commit/rollback, Argon2id passwords, JWT auth, RBAC (`@Roles`), and throttling
- [`examples/websocket-chat`](./examples/websocket-chat) — Native Bun WebSocket rooms & handshake auth
- [`examples/distributed-worker`](./examples/distributed-worker) — Declarative `@Span()`, `@EmitEvent()`, `OrderRepository`, and `ObservabilityModule.forRoot()` with W3C trace propagation across HTTP -> SQLite -> CQRS -> Queue worker + `/health` & `/metrics`
- [`apps/playground`](./apps/playground) — Full Decorator-First showcase (`@Entity("todos")` driving SQLite `autoSync: true`, `ValidationPipe`, and OpenAPI 3.1 `/docs` + `design:returntype`; auto-registered `@Span`-woven `TodoRepository`; `@Transactional()` + `@Span()` service; `ObservabilityModule.forRoot()` + `/health` + `/metrics` + `/_devtools/graph`)

---

## Workspace Commands

```bash
bun install             # Install & link all 53 workspace packages
bun test                # Run full test suite (6,344 pass / 0 fail)
bun run typecheck       # Fast Bun native typecheck (`bun check`)
bunx tsc --noEmit       # Full TypeScript compiler check
bun run build           # Build all 53 packages + docs site
bun run bench           # Run reproducible benchmark suite
bun run verify:release  # Validate publish metadata, DAG, cycles & CLI smoke test across all 53 packages
```

---

## Known Limitations

- **Bun-only runtime (`>= 1.4.3`):** Node.js and Deno are intentionally not supported in core ([ADR-001](./docs/adr/ADR-001.md)).
- **Legacy TypeScript decorators only:** Requires `experimentalDecorators: true` and `emitDecoratorMetadata: true`; TC39 Stage 3 standard decorators are not used ([ADR-002](./docs/adr/ADR-002.md)).
- **`verbatimModuleSyntax: true` import discipline:** DI services, repositories, and DTO classes MUST be value-imported (never `import type`), while TypeScript interfaces and type aliases MUST use `import type` to avoid Bun single-file runtime import errors ([ADR-002](./docs/adr/ADR-002.md)).
- **No Express/Fastify/Passport drop-in middleware:** Use native `BunestMiddleware` (`@UseMiddleware()`), `CanActivate` guards, or `@bunest/security` / `@bunest/authentication` / `@bunest/authorization` instead of Express `(req, res, next)` middleware.
- **Promise-based interceptors (no RxJS):** `CallHandler.handle()` returns `Promise<T>`, not an RxJS `Observable` ([ADR-008](./docs/adr/ADR-008.md)).
- **`design:paramtypes` erasure:** TypeScript interfaces, unions, and generic type parameters erase at runtime—use explicit `@Inject(TOKEN)`, `@Type()`, or `@ApiProperty()` where reflection cannot infer a class constructor.
- **External broker & third-party ORM wire drivers are pluggable:** Redis (`@bunest/cache`, `@bunest/queues`, `@bunest/microservices`), NATS, RabbitMQ, Kafka, MQTT, and third-party ORM engines (`@bunest/typeorm`, `@bunest/mongoose`, `@bunest/sequelize`, `@bunest/drizzle`, `@bunest/prisma`) accept typed client interfaces rather than bundling heavy external drivers in core, while Bun-native `bun:sqlite`, `Bun.SQL`, `fetch()`, and in-memory adapters work out of the box with zero external deps.
- **Benchmarks scope:** Core numbers above compare Bunest directly against raw `Bun.serve()` ([`benchmarks/RESULTS.md`](./benchmarks/RESULTS.md)), and reproducible 8-target head-to-head benchmarks against upstream NestJS `v12.5.1` on both Bun and Node.js are published in [`benchmarks/nestjs-comparison/RESULTS.md`](./benchmarks/nestjs-comparison/RESULTS.md); comparisons against other frameworks (e.g. Elysia, Hono) are not claimed until measured under an equivalent reproducible harness.

---

## Governance & License

- [Contributing Guide](./CONTRIBUTING.md) · [Security Policy](./SECURITY.md) · [Changelog](./CHANGELOG.md) · [MIT License](./LICENSE)
