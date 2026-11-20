# Packages & Monorepo

Bunest is organized as a **53-package Bun workspace monorepo** with **0 circular imports**, **0 RxJS**, and **48/53 packages having zero external npm runtime dependencies**.

> info **100% ADR-Adjusted NestJS v12 Parity** Every package below is implemented, tested, and verified in the monorepo. Drop-in `@nestjs/*` facade packages let teams keep familiar package names while running Bunest's native zero-dependency implementations underneath.

## Core, HTTP & Validation (6 Packages)

| Package | Responsibility | Documentation |
|---|---|---|
| **`@bunest/common`** | Shared decorators, `MetadataRegistry`, `Reflector`, `createMethodAspectDecorator`, `@UseMiddleware`, `HttpException` (23 subclasses), built-in `Parse*` pipes, `ConsoleLogger`, `StreamableFile`, `ConfigurableModuleBuilder` | [Controllers](/overview/controllers), [Service-Layer AOP](/techniques/service-aop) |
| **`@bunest/core`** | `ModuleScanner`, strict `DIContainer`, `MethodAspectWeaver`, `RequestContainer`, `ModuleRef`, `LifecycleManager`, `RouterModule`, `LazyModuleLoader`, `ClsModule`/`@WithCls`, `DiscoveryService`, `GraphInspector`, `repl()` | [Modules](/overview/modules), [Providers](/overview/providers), [Service-Layer AOP](/techniques/service-aop) |
| **`@bunest/http`** | Bun-native `AbstractHttpAdapter` & `BunHttpAdapter`, `ControllerScanner`, hybrid `Bun.serve({ routes })` + `FallbackRadixRouter`, Fetch-Metadata CSRF, Helmet-8 headers, signed cookies, `@Render`, API Versioning, `CompressionMiddleware`, `useStaticAssets` | [Hybrid Router](/architecture/hybrid-router), [Execution Pipeline](/architecture/execution-pipeline) |
| **`@bunest/validation`** | Secure-by-default `ValidationPipe` (`class-validator` + `class-transformer`), `StandardSchemaValidationPipe`, `SchemaValidationPipe`, `ClassSerializerInterceptor`, `StandardSchemaSerializerInterceptor` | [Validation](/techniques/validation), [Serialization](/techniques/serialization) |
| **`@bunest/mapped-types`** | `PartialType`, `PickType`, `OmitType`, variadic `IntersectionType`, `CompositionType`, and metadata inheritance helpers | [Mapped Types](/techniques/mapped-types) |
| **`@bunest/testing`** | `Test.createTestingModule`, overrides, `ModuleMocker`, zero-socket `request(app)` & `TestClient`, `app.inject()`, `readSseEvents`, `CapturingLogger`, `ContextIdFactory` | [Testing](/fundamentals/testing) |

## Techniques, DX & Utilities (12 Packages)

| Package | Responsibility | Documentation |
|---|---|---|
| **`@bunest/config`** | `ConfigModule`, `ConfigService`, `.env` loader with `${VAR}` expansion, `registerAs`, DTO & Standard Schema validation, `@InjectConfig`, `@ConfigValue`, secret redactor | [Configuration](/techniques/configuration) |
| **`@bunest/cache`** | `CacheModule`, `CacheService`, `CacheInterceptor`, `@Cacheable`/`@CacheEvict`/`@CachePut`, single-flight deduplication, `MemoryCacheStore`, `RedisCacheStore` | [Caching](/techniques/caching) |
| **`@bunest/scheduler`** | `ScheduleModule`, pure-TS 5/6-field DST-aware cron parser, `@Cron`, `CronExpression` (83 presets), `@Interval`, `@Timeout`, overlap protection | [Task Scheduling](/techniques/task-scheduling) |
| **`@bunest/events`** | `EventEmitterModule`, `EventEmitter2`, `@OnEvent`, `@EmitEvent`, `@EventPayload`, wildcard `*`/`**` matching, sync & async dispatch | [Events](/techniques/events) |
| **`@bunest/queues`** | `QueueModule`, `@Processor`/`@Process`, retries/backoff/DLQ, `MemoryQueueDriver`, atomic Lua `RedisQueueDriver`, `BullMQModule` | [Queues & Bull](/techniques/queues) |
| **`@bunest/bull`** | Classic `@nestjs/bull`-compatible `BullModule`, `@Processor`/`@Process`/`@OnQueue*` & `BullExplorer` backed by `@bunest/queues` | [Queues & Bull](/techniques/queues) |
| **`@bunest/bullmq`** | Drop-in `@nestjs/bullmq` migration facade backed natively by `@bunest/queues` | [Queues & Bull](/techniques/queues) |
| **`@bunest/http-client`** | Zero-dep native `fetch()` HTTP client with named clients, retries, timeouts, interceptors, and typed errors | [HTTP Client & Axios](/techniques/http-client) |
| **`@bunest/axios`** | Drop-in `@nestjs/axios`-compatible `HttpModule` & `HttpService` on native `fetch()` (zero external deps, zero RxJS) | [HTTP Client & Axios](/techniques/http-client) |
| **`@bunest/i18n`** | Per-request `AsyncLocalStorage` locale resolution, typed translations, `Intl` formatting, and localized validation messages | [Internationalization (i18n)](/techniques/i18n) |
| **`@bunest/mail`** | Typed mail classes, auto-escaped HTML templates, and native SMTP, Resend, Postmark, SendGrid & Amazon SES transports | [Mail](/techniques/mail) |
| **`@bunest/storage`** | Unified storage API for local disks, in-memory disks, and S3/R2/MinIO with native WebCrypto SigV4 `fetch()` and signed URLs | [Storage & Static Files](/techniques/storage) |
| **`@bunest/serve-static`** | Drop-in `@nestjs/serve-static` migration facade backed natively by `@bunest/http` (`Bun.file()`) | [Storage & Static Files](/techniques/storage) |

## Data & Persistence (9 Packages)

| Package | Responsibility | Documentation |
|---|---|---|
| **`@bunest/sqlite`** | Bun-native `bun:sqlite`: `SqliteModule`, `SqliteService`, `@Transactional`, `@SqliteRepository`/`JpaRepository`/`@Query`/`@Modifying`/`@SqlParam` + compiled-once derived finders, migrations | [SQLite](/data/sqlite) |
| **`@bunest/sql`** | Bun-native `Bun.SQL` (Postgres/MySQL/SQLite): `SqlModule`, `SqlService`, `@Transactional`, dialect-aware `@SqlRepository`/`SqlCrudRepository`/`@SqlQuery`, migrations | [SQL (Bun.SQL)](/data/sql) |
| **`@bunest/prisma`** | Drop-in Prisma integration: `PrismaModule`, `PrismaService`, `PrismaClientExceptionFilter`, `@InjectPrisma`, ALS transactions | [ORM & ODM Adapters](/data/orm-adapters) |
| **`@bunest/drizzle`** | `DrizzleModule`, `@InjectDrizzle`, automatic client shutdown & `@bunest/sql` ALS transaction integration | [ORM & ODM Adapters](/data/orm-adapters) |
| **`@bunest/typeorm`** | `@nestjs/typeorm` v12 parity: `TypeOrmModule`, `@InjectRepository`/`@InjectDataSource`/`@InjectEntityManager`, multi-DataSource DI lifecycle | [ORM & ODM Adapters](/data/orm-adapters) |
| **`@bunest/mongoose`** | `@nestjs/mongoose` v12 parity: `MongooseModule`, `@Schema`/`@Prop`/`@InjectModel`/`@InjectConnection`, `SchemaFactory`, `IsObjectIdPipe` | [ORM & ODM Adapters](/data/orm-adapters) |
| **`@bunest/sequelize`** | `@nestjs/sequelize` v12 parity: `SequelizeModule`, `@InjectModel`/`@InjectConnection`, multi-connection DI lifecycle | [ORM & ODM Adapters](/data/orm-adapters) |
| **`@bunest/elasticsearch`** | `@nestjs/elasticsearch` v12 parity: `ElasticsearchModule` + full native Bun `fetch()` REST client | [Elasticsearch](/data/elasticsearch) |
| **`@bunest/store-kit`** | Foundational `Bun.SQL` store kit (`.`, `./postgres`, `./mysql`, `./testing`) with versioned migrations, CLI, and contract testing | [Store Kit](/data/store-kit) |

## Security & Identity (6 Packages)

| Package | Responsibility | Documentation |
|---|---|---|
| **`@bunest/security`** | `SecurityModule.forRoot()`, `@Auth()`, `@Protected()`, WebCrypto `JwtModule`, `JwksModule`, `OAuth2Module`/`OidcModule` (PKCE), `PasswordService` (`argon2id`), RBAC/Policies, CSRF, `ThrottlerModule`, security headers | [Security, JWT & Throttler](/security/security-module) |
| **`@bunest/jwt`** | Drop-in `@nestjs/jwt` v12 migration facade backed natively by `@bunest/security` (WebCrypto) | [Security, JWT & Throttler](/security/security-module) |
| **`@bunest/passport`** | Drop-in `@nestjs/passport` v12 migration facade (`PassportModule`, `AuthGuard`, `PassportStrategy`) backed by `@bunest/security` | [Security, JWT & Throttler](/security/security-module) |
| **`@bunest/throttler`** | Drop-in `@nestjs/throttler` v6.8 migration facade (`ThrottlerModule`, `ThrottlerGuard`, `@Throttle`, `@SkipThrottle`) backed by `@bunest/security` | [Security, JWT & Throttler](/security/security-module) |
| **`@bunest/authentication`** | Full identity suite: sessions, JWT/JWKS, refresh-token families, TOTP MFA, magic links, OIDC/OAuth2, API keys, Argon2id, `./testing` | [Authentication](/security/authentication) |
| **`@bunest/authorization`** | Policy-based authorization with `@Policy()` classes, `@Can()` / `@Can.Anyone()`, `AuthorizationService`, and audit events | [Authorization](/security/authorization) |

## API, GraphQL & Realtime (4 Packages)

| Package | Responsibility | Documentation |
|---|---|---|
| **`@bunest/swagger`** | OpenAPI 3.1 generator, `DocumentBuilder`, `SwaggerModule`, `@Api*` decorators, Interactive Try-It-Out UI + Scalar/Swagger-UI presets | [OpenAPI (Swagger)](/apis/openapi) |
| **`@bunest/graphql`** | Code-first & schema-first GraphQL, Federation v2 Subgraph, `@UseFilters`, `BunestDataLoader`, SSE & `graphql-ws` subscriptions | [GraphQL & Apollo](/apis/graphql) |
| **`@bunest/apollo`** | Bun-native `ApolloDriver`, `ApolloFederationDriver` (Federation v2 Subgraph), and `ApolloGatewayDriver` (multi-subgraph gateway) | [GraphQL & Apollo](/apis/graphql) |
| **`@bunest/websockets`** | Native `Bun.serve({ websocket })` gateways: `@WebSocketGateway`, `@SubscribeMessage`, `@Ack()`, rooms/pub-sub, handshake auth, WS enhancers | [WebSockets](/apis/websockets) |

## Distributed Systems & Reliability (8 Packages)

| Package | Responsibility | Documentation |
|---|---|---|
| **`@bunest/microservices`** | `@MessagePattern`, `@EventPattern`, `@GrpcMethod`, `ClientProxy`, hybrid `connectMicroservice()`, TCP, InMemory, gRPC, Kafka, MQTT, Redis, NATS & RabbitMQ | [Microservices](/distributed/microservices) |
| **`@bunest/cqrs`** | `CqrsModule`, `CommandBus`, `QueryBus`, `EventBus`, `AggregateRoot`, `EventPublisher`, `@Saga` | [CQRS](/distributed/cqrs) |
| **`@bunest/resilience`** | `@Retry`, `@Timeout`, `@CircuitBreaker`, `@Bulkhead`, `@RateLimit`, `@Fallback` on both transport entrypoints AND `@Injectable()` service methods | [Resilience](/distributed/resilience) |
| **`@bunest/locks`** | Distributed leased locks with fencing tokens, `@WithLock()`, `@OnOneInstance()`, `@WithoutOverlapping()`, and leader election | [Locks & Idempotency](/distributed/locks-idempotency) |
| **`@bunest/idempotency`** | `@Idempotent()` safe retry deduplication for HTTP routes, GraphQL mutations, and microservice handlers | [Locks & Idempotency](/distributed/locks-idempotency) |
| **`@bunest/outbox`** | Transactional outbox, consumer inbox deduplication, leased relay, dead-letter management, Postgres/MySQL/testing subpaths + CLI | [Outbox & Webhooks](/distributed/outbox-webhooks) |
| **`@bunest/webhooks`** | Outbound webhook delivery (HMAC-SHA256, SSRF `AddressPolicy`, AES-256-GCM sealing, backoff) & inbound verification (Standard Webhooks, Stripe, GitHub) | [Outbox & Webhooks](/distributed/outbox-webhooks) |
| **`@bunest/workflows`** | Durable workflows written as plain async code with deterministic replay, signals, timers, sagas, schedules, CQRS/Postgres/MySQL/testing subpaths + CLI | [Durable Workflows](/distributed/workflows) |

## AI & Agents (2 Packages)

| Package | Responsibility | Documentation |
|---|---|---|
| **`@bunest/ai`** | Native `fetch()` SSE clients for OpenAI, Anthropic & Google Gemini; `generateText`, `generateObject`, `streamText`, embeddings, `@AgentFunction`, `./testing`, `./workflows` | [AI SDK](/ai/ai-sdk) |
| **`@bunest/mcp`** | Model Context Protocol server exposing `@Tool`, `@Resource`, `@ResourceTemplate`, and `@Prompt` over Streamable HTTP, SSE, and stdio JSON-RPC 2.0 | [Model Context Protocol (MCP)](/ai/mcp) |

## Observability & Developer CLI (5 Packages)

| Package | Responsibility | Documentation |
|---|---|---|
| **`@bunest/observability`** | `ObservabilityModule.forRoot()`, `@Span`/`@Trace`/`@Timed`/`@Counted`, W3C Trace Context, OTLP HTTP export, Prometheus metrics, health checks, Devtools graph | [Observability, Terminus & Devtools](/observability/observability) |
| **`@bunest/terminus`** | Drop-in `@nestjs/terminus` v12 migration facade (`TerminusModule`, `HealthCheckService`, built-in health indicators) backed by `@bunest/observability` | [Observability, Terminus & Devtools](/observability/observability) |
| **`@bunest/devtools-integration`** | Drop-in `@nestjs/devtools-integration` v12 migration facade (`DevtoolsModule`, `GraphPublisher`) backed by `@bunest/observability` | [Observability, Terminus & Devtools](/observability/observability) |
| **`@bunest/observe`** | Full APM agent with distributed tracing, runtime/custom metrics, SLO objectives, PII redaction, OTLP export, and CLI | [Observe APM](/observability/observe) |
| **`@bunest/cli`** | `bunest new`, `generate`/`g` (11 schematics), `dev`, `build`, `repl`, `info`, and `bunestMetadataPlugin()` for `Bun.build()` | [CLI](/observability/cli) |

## Workspace Commands

```bash
bun install             # Install & link all 53 workspace packages
bun test                # Run full test suite via bun:test
bun run typecheck       # Multi-threaded typecheck (`bun check`)
bun run build           # Build all 53 packages + docs site
bun run docs:dev        # Start this documentation site locally
bun run docs:build      # Build static documentation bundle to apps/docs/dist
bun run verify:release  # Validate publish metadata, DAG, cycles & CLI smoke tests
```
