# Packages & Monorepo

Bunest is organized as a **19-package, 6-domain Bun workspace monorepo** (`Bun >= 1.4.5`) with **0 circular imports**, **0 RxJS**, **19/19 packages (100%) having zero external npm runtime dependencies**, and **0 `node:*` imports repo-wide** outside the 2 quarantined kernel adapters in `@bunest/core` ([ADR-017](/architecture/adrs)).

> info **Consolidated Subpath Architecture (ADR-016)** Related capabilities live together inside cohesive domain packages and expose tree-shakeable ESM subpaths (`@bunest/core/config`, `@bunest/security/auth`, `@bunest/messaging/events`, `@bunest/jobs/queues`, etc.).

## 1. Core & Validation (2 Packages)

| Package | Subpaths | Responsibility | Documentation |
| --- | --- | --- | --- |
| **`@bunest/core`** | `.`, `./common`, `./http`, `./config`, `./client`, `./ws`, `./i18n` | Unified core runtime: decorators, `MetadataRegistry`, `Reflector`, `DIContainer`, `MethodAspectWeaver`, hybrid `Bun.serve({ routes, fetch, websocket })` + `FallbackRadixRouter`, `Bun.Cookie`, Helmet-8 headers, `ServeStaticModule`, `ConfigModule` (`.env` + `Bun.YAML`/`TOML`/`JSONC`), zero-dep `fetch()` HTTP client (`./client`), native WebSocket gateways (`./ws`), ALS `I18nModule` (`./i18n`), `ClsModule`, `GraphInspector`, `repl()` | [Controllers](/overview/controllers), [Modules](/overview/modules), [Configuration](/techniques/configuration), [WebSockets](/apis/websockets) |
| **`@bunest/validation`** | `.`, `./validator`, `./transformer`, `./standard-schema` | Zero-external-dep compile-once Bun-native DTO validator (**336/336** `class-validator` API) & transformer (**21/21** `class-transformer` API), `ValidationPipe`, `StandardSchemaValidationPipe`, `SchemaValidationPipe`, `ClassSerializerInterceptor`, mapped DTO helpers, and seamless dual-engine coexistence | [Validation](/techniques/validation), [Mapped Types](/techniques/mapped-types) |

## 2. Security (1 Package)

| Package | Subpaths | Responsibility | Documentation |
| --- | --- | --- | --- |
| **`@bunest/security`** | `.`, `./auth`, `./authz`, `./jwt`, `./throttler`, `./testing` | `SecurityModule.forRoot()`, `@Auth()`, `@Protected()`, WebCrypto `JwtModule`/`JwksModule`/`OAuth2`/`Oidc` (PKCE), `PassportModule`, sessions, refresh-token families, TOTP MFA, magic links, API keys, `Bun.password` (`argon2id`), `Bun.CSRF`, policy-based `@Policy()`/`@Can()` authorization (`./authz`), `ThrottlerModule` (`./throttler`), and `SecurityHeadersMiddleware` | [Security, JWT & Throttler](/security/security-module), [Authentication](/security/authentication), [Authorization](/security/authorization) |

## 3. API & AI (3 Packages)

| Package | Subpaths | Responsibility | Documentation |
| --- | --- | --- | --- |
| **`@bunest/swagger`** | `.` | OpenAPI 3.1 generator, `DocumentBuilder`, `SwaggerModule`, `@Api*` decorators, Interactive Try-It-Out UI + Scalar/Swagger-UI presets | [OpenAPI (Swagger)](/apis/openapi) |
| **`@bunest/graphql`** | `.`, `./apollo` | Code-first & schema-first GraphQL, `ApolloDriver`, Federation v2 Subgraph & Gateway (`./apollo`), `@UseFilters`, `BunestDataLoader`, SSE & `graphql-ws` subscriptions | [GraphQL & Apollo](/apis/graphql) |
| **`@bunest/ai`** | `.`, `./mcp`, `./mcp/testing`, `./workflows`, `./testing` | Native `fetch()` SSE clients for OpenAI, Anthropic & Google Gemini (`generateText`, `generateObject`, `streamText`, `@AgentFunction`, durable agent workflows) + Model Context Protocol server (`./mcp`: `@Tool`, `@Resource`, `@ResourceTemplate`, `@Prompt` over Streamable HTTP, SSE & stdio JSON-RPC 2.0) | [AI SDK](/ai/ai-sdk), [Model Context Protocol (MCP)](/ai/mcp) |

## 4. Data & Integrations (5 Packages)

| Package | Subpaths | Responsibility | Documentation |
| --- | --- | --- | --- |
| **`@bunest/orm`** | `.`, `./plugin`, `./store`, `./postgres`, `./mysql`, `./testing` | Zero-dep Bun-native ORM & SQL toolkit covering 12 dialects via `bun:sqlite`, `Bun.SQL`, `fetch()`, & `Bun.connect()`, with `@OrmRepository`/`CrudRepository`/`@Query`/`@Modifying`, `@Transactional`, `OrmMigrationRunner`, and SQL Store Kit (`createBunSqlExecutor`) | [Bunest ORM](/data/orm-adapters), [SQLite](/data/sqlite), [SQL (Bun.SQL)](/data/sql), [Store Kit](/data/store-kit) |
| **`@bunest/cache`** | `.`, `./redis` | `CacheModule`, `CacheService`, `CacheInterceptor`, `@Cacheable`/`@CacheEvict`/`@CachePut`, single-flight deduplication, `MemoryCacheStore`, and native `Bun.RedisClient` `RedisCacheStore` (`./redis`) | [Caching](/techniques/caching) |
| **`@bunest/storage`** | `.`, `./s3`, `./local`, `./memory` | Unified storage API: `LocalDisk` (`Bun.file().slice().stream()`), `InMemoryDisk`, native `BunS3Disk` (`Bun.S3Client`/`Bun.s3`), and SigV4 `S3Disk` (`Bun.CryptoHasher` + `Bun.XML.parse`) | [Storage & Static Files](/techniques/storage) |
| **`@bunest/mail`** | `.`, `./smtp`, `./templates` | Typed mail classes, `Bun.escapeHTML` templates (`./templates`), native SMTP (`./smtp`), Resend, Postmark, SendGrid & Amazon SES transports | [Mail](/techniques/mail) |
| **`@bunest/elasticsearch`** | `.` | `@nestjs/elasticsearch` v12 parity: `ElasticsearchModule` + zero-dep native Bun `fetch()` REST client | [Elasticsearch](/data/elasticsearch) |

## 5. Distributed & Async (5 Packages)

| Package | Subpaths | Responsibility | Documentation |
| --- | --- | --- | --- |
| **`@bunest/messaging`** | `.`, `./events`, `./cqrs`, `./outbox/*`, `./webhooks/*` | EventEmitter2 (`./events`), CQRS (`./cqrs`), transactional outbox & consumer inbox (`./outbox`, Postgres/MySQL/testing + `nest-outbox` CLI), and outbound/inbound webhooks (`./webhooks`, `Bun.dns.lookup`, HMAC-SHA256, SSRF `AddressPolicy`, AES-256-GCM sealing + `nest-webhooks` CLI) | [Events](/techniques/events), [CQRS](/distributed/cqrs), [Outbox & Webhooks](/distributed/outbox-webhooks) |
| **`@bunest/jobs`** | `.`, `./queues`, `./scheduler`, `./redis` | `QueueModule`, `BullModule`/`BullMQModule`, `@Processor`/`@Process`, `WorkerHost`, `FlowProducer`, retries/backoff/DLQ, `MemoryQueueDriver`, atomic Lua `RedisQueueDriver` backed by `Bun.RedisClient` (`./queues`, `./redis`), and `ScheduleModule`/`@Cron` with `Bun.cron.parse` fast-path (`./scheduler`) | [Queues](/techniques/queues), [Task Scheduling](/techniques/task-scheduling) |
| **`@bunest/resilience`** | `.`, `./locks/*`, `./idempotency/*` | `@Retry`, `@Timeout`, `@CircuitBreaker`, `@Bulkhead`, `@RateLimit`, `@Fallback` (entrypoint + service-layer AOP), distributed leased locks with fencing tokens & `@WithLock()`/`@OnOneInstance()` (`./locks`), and `@Idempotent()` safe retry deduplication (`./idempotency`) | [Resilience](/distributed/resilience), [Locks & Idempotency](/distributed/locks-idempotency) |
| **`@bunest/microservices`** | `.` | `@MessagePattern`, `@EventPattern`, `@GrpcMethod`, `ClientProxy`, hybrid `connectMicroservice()`, TCP, InMemory, gRPC, Kafka, MQTT, native `Bun.RedisClient` Redis, NATS & RabbitMQ | [Microservices](/distributed/microservices) |
| **`@bunest/workflows`** | `.`, `./core`, `./cqrs`, `./postgres`, `./mysql`, `./testing` | Durable workflows written as plain async code with deterministic replay, signals, timers, sagas, schedules, `Bun.deflateSync` AES-GCM codec, SQL stores & CLI | [Durable Workflows](/distributed/workflows) |

## 6. DX & Ops (3 Packages)

| Package | Subpaths | Responsibility | Documentation |
| --- | --- | --- | --- |
| **`@bunest/observability`** | `.`, `./tracing`, `./metrics`, `./health`, `./devtools` | `ObservabilityModule.forRoot()`, `@Span`/`@Trace`/`@Timed`/`@Counted`, W3C Trace Context + OTLP (`./tracing`), Prometheus metrics (`./metrics`), `TerminusModule`/`HealthModule` with `Bun.connect()` TCP probes (`./health`), and `DevtoolsModule` graph (`./devtools`) | [Observability, Health & Devtools](/observability/observability) |
| **`@bunest/testing`** | `.` | `Test.createTestingModule`, overrides, `ModuleMocker`, zero-socket `request(app)` & `TestClient`, `app.inject()`, `readSseEvents`, `CapturingLogger`, `ContextIdFactory` | [Testing](/fundamentals/testing) |
| **`@bunest/cli`** | `.`, `./analyzer` | `bunest new`, `generate`/`g`, `dev`, `start`, `build`, `check`/`doctor`, `typegen`, `delombok`, `codemod`, `add`, `upgrade`, `deploy`, `repl`, `info`, and `bunestMetadataPlugin()` for `Bun.build()` | [CLI](/observability/cli) |

## Workspace Commands

```bash
bun install             # Install & link all 19 workspace packages
bun test                # Run full test suite via bun:test
bun run typecheck       # Multi-threaded typecheck (`bun check`)
bun run build           # Build all 19 packages + docs site
bun run docs:dev        # Start this documentation site locally
bun run docs:build      # Build static documentation bundle to apps/docs/dist
bun run verify:release  # Validate publish metadata, subpath exports, DAG, cycles & CLI smoke tests
```
