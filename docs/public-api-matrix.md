# Bunest Public API Matrix & Stability Contract

This document is the authoritative inventory of every public package and `package.json#exports` entrypoint shipped by the Bunest monorepo (**19 lockstep-versioned `@bunest/*` packages**, **95 declared `exports` keys**: **76** runtime/type entrypoints — 19 root `.` + 57 named subpaths — plus **19** `./package.json` metadata exports).

Every stability tier below is aligned 1:1 with [`docs/support-policy.md`](./support-policy.md) and [`docs/production-preview.md`](./production-preview.md).

---

## 1. Public API Boundary

- **Public contract**: Only symbols re-exported from the declared `package.json#exports` entrypoints listed in this document are part of Bunest's public API.
- **Internal files**: Importing directly from `src/*`, `dist/*`, or any undeclared path is unsupported and may break in any patch release.
- **Zero external runtime dependencies (`ADR-017`)**: All 19 `@bunest/*` packages ship with `0` third-party runtime dependencies and target **Bun `>= 1.4.5`**.
- **Lockstep versioning**: All 19 packages share the exact same version number on every release (currently `0.1.0`).

---

## 2. Stability Tier Summary

| Stability Tier | Target for `1.0` | Packages (19 total) | Qualification Criteria |
| --- | --- | --- | --- |
| **Production Preview (`0.1`)** | **`1.0 Stable Candidate`** | `@bunest/core` (HTTP, DI, Config), `@bunest/validation`, `@bunest/orm` (PostgreSQL via `Bun.SQL`, explicit migrations), `@bunest/observability` (logging, health, metrics) — **4 packages** | Pinned Linux CI (`Bun 1.4.5`) green, real PostgreSQL persistence/migration/outage/backup smoke suite, 2h soak gate (`p95 < 200 ms`, `5xx < 0.1%`, stable RSS), `< 5 min` rollback rehearsal, clean out-of-repo registry install & upgrade. |
| **Beta (Integration-Verified)** | Promoted per module in `0.2.x+` or `1.0` | `@bunest/cache`, `@bunest/jobs`, `@bunest/security`, `@bunest/swagger`, `@bunest/testing`, `@bunest/cli`, `@bunest/resilience` (+ `@bunest/orm` SQLite, non-preview subpaths of `@bunest/core` / `@bunest/observability`) — **7 packages** | Full unit & conformance coverage + real-service integration tests (Redis / SQLite) in CI. |
| **Preview / Experimental** | Promoted on real-infrastructure verification | `@bunest/ai`, `@bunest/elasticsearch`, `@bunest/graphql`, `@bunest/mail`, `@bunest/messaging`, `@bunest/microservices`, `@bunest/storage`, `@bunest/workflows` (+ `@bunest/core/ws`, non-PostgreSQL `Bun.SQL` dialects) — **8 packages** | Functional with 100% conformance / unit tests; awaiting dedicated real-service fault-injection & soak verification before promotion. |

---

## 3. Complete Package & Subpath Inventory (19 Packages, 95 Exports)

> **Export counts**: Each package exposes a root `.` entrypoint, optional named ESM subpaths, and `./package.json` for tooling introspection. Totals: **19** root `.` + **57** named subpaths = **76** code entrypoints, plus **19** `./package.json` metadata exports (**95** total `package.json#exports` keys).

### 3.1 Production Preview (`0.1`) → `1.0 Stable Candidate` (4 Packages, 26 Exports)

#### `@bunest/core` (`0.1.0` — 8 exports)

| Export Subpath | Source Entry | Stability Tier | `1.0` Target | Notes / Scope |
| --- | --- | --- | --- | --- |
| `@bunest/core` (`.`) | `./src/index.ts` | **Production Preview (`0.1`)** | `1.0 Stable Candidate` | DI container, `@Module()` graph, `BunestFactory`, lifecycle hooks, `MethodAspectWeaver` |
| `@bunest/core/common` | `./src/common/index.ts` | **Production Preview (`0.1`)** | `1.0 Stable Candidate` | Decorators, exceptions, guards, interceptors, pipes, filters, `Logger`, `Reflector` |
| `@bunest/core/http` | `./src/http/index.ts` | **Production Preview (`0.1`)** | `1.0 Stable Candidate` | `BunHttpAdapter`, hybrid `Bun.serve` + `FallbackRadixRouter`, middleware, cookies, CSRF, Helmet headers |
| `@bunest/core/config` | `./src/config/index.ts` | **Production Preview (`0.1`)** | `1.0 Stable Candidate` | `ConfigModule`, `ConfigService`, `.env` / YAML / TOML / JSONC loaders |
| `@bunest/core/client` | `./src/client/index.ts` | **Beta (Integration-Verified)** | `1.0 Candidate (post-pilot)` | Zero-dep `fetch()` HTTP client (`HttpModule` / `HttpService`) |
| `@bunest/core/i18n` | `./src/i18n/index.ts` | **Beta (Integration-Verified)** | `1.0 Candidate (post-pilot)` | `AsyncLocalStorage`-backed `I18nModule` |
| `@bunest/core/ws` | `./src/ws/index.ts` | **Preview / Experimental** | `0.2.x+` evaluation | Native Bun WebSocket gateways (excluded from `0.1` production preview SLA) |
| `@bunest/core/package.json` | `./package.json` | **Production Preview (`0.1`)** | `1.0 Stable Candidate` | Package manifest metadata |

#### `@bunest/validation` (`0.1.0` — 5 exports)

| Export Subpath | Source Entry | Stability Tier | `1.0` Target | Notes / Scope |
| --- | --- | --- | --- | --- |
| `@bunest/validation` (`.`) | `./src/index.ts` | **Production Preview (`0.1`)** | `1.0 Stable Candidate` | `ValidationPipe`, `ClassSerializerInterceptor`, mapped DTO helpers (`PartialType`, `PickType`, `OmitType`, `IntersectionType`) |
| `@bunest/validation/validator` | `./src/validator/index.ts` | **Production Preview (`0.1`)** | `1.0 Stable Candidate` | Zero-dep compile-once DTO validator (`class-validator` parity, `ADR-015`) |
| `@bunest/validation/transformer` | `./src/transformer/index.ts` | **Production Preview (`0.1`)** | `1.0 Stable Candidate` | Zero-dep DTO transformer (`class-transformer` parity, `ADR-015`) |
| `@bunest/validation/standard-schema` | `./src/standard-schema/index.ts` | **Production Preview (`0.1`)** | `1.0 Stable Candidate` | `StandardSchemaV1` / `StandardSchemaValidationPipe` interoperability |
| `@bunest/validation/package.json` | `./package.json` | **Production Preview (`0.1`)** | `1.0 Stable Candidate` | Package manifest metadata |

#### `@bunest/orm` (`0.1.0` — 7 exports)

| Export Subpath | Source Entry | Stability Tier | `1.0` Target | Notes / Scope |
| --- | --- | --- | --- | --- |
| `@bunest/orm` (`.`) | `./src/index.ts` | **Production Preview (`0.1`)** *(PostgreSQL)* | `1.0 Stable Candidate` *(PostgreSQL)* | PostgreSQL via `Bun.SQL` with explicit migrations (`synchronize: false`). SQLite is **Beta**; MySQL/MariaDB/MongoDB/LibSQL/D1 are **Preview / Experimental**. |
| `@bunest/orm/postgres` | `./src/store-kit/postgres/index.ts` | **Production Preview (`0.1`)** | `1.0 Stable Candidate` | PostgreSQL SQL Store Kit primitives |
| `@bunest/orm/store` | `./src/store-kit/index.ts` | **Production Preview (`0.1`)** *(PostgreSQL)* | `1.0 Stable Candidate` *(PostgreSQL)* | Shared SQL Store Kit (`createBunSqlExecutor`); PostgreSQL is Production Preview, MySQL is Preview / Experimental |
| `@bunest/orm/plugin` | `./src/plugin.ts` | **Beta (Integration-Verified)** | `1.0 Candidate (post-pilot)` | ORM plugin & dialect extension hooks (`ADR-018`) |
| `@bunest/orm/testing` | `./src/store-kit/testing/index.ts` | **Beta (Integration-Verified)** | `1.0 Candidate (post-pilot)` | Store Kit in-memory/test helpers |
| `@bunest/orm/mysql` | `./src/store-kit/mysql/index.ts` | **Preview / Experimental** | `0.2.x+` evaluation | MySQL SQL Store Kit (non-PostgreSQL dialect) |
| `@bunest/orm/package.json` | `./package.json` | **Production Preview (`0.1`)** | `1.0 Stable Candidate` | Package manifest metadata |

#### `@bunest/observability` (`0.1.0` — 6 exports)

| Export Subpath | Source Entry | Stability Tier | `1.0` Target | Notes / Scope |
| --- | --- | --- | --- | --- |
| `@bunest/observability` (`.`) | `./src/index.ts` | **Production Preview (`0.1`)** | `1.0 Stable Candidate` | `ObservabilityModule.forRoot()`, structured JSON logging with secret redaction, request correlation |
| `@bunest/observability/health` | `./src/health/index.ts` | **Production Preview (`0.1`)** | `1.0 Stable Candidate` | `TerminusModule` / `HealthModule`, `/live` & `/ready` probes, `Bun.connect()` TCP indicators |
| `@bunest/observability/metrics` | `./src/metrics/index.ts` | **Production Preview (`0.1`)** | `1.0 Stable Candidate` | Internal Prometheus `/metrics`, `@Timed`, `@Counted` |
| `@bunest/observability/tracing` | `./src/tracing/index.ts` | **Beta (Integration-Verified)** | `1.0 Candidate (post-pilot)` | W3C Trace Context, `@Span`, `@Trace`, OTLP exporter |
| `@bunest/observability/devtools` | `./src/devtools/index.ts` | **Beta (Integration-Verified)** | `1.0 Candidate (post-pilot)` | `DevtoolsModule` DI/module graph introspection |
| `@bunest/observability/package.json` | `./package.json` | **Production Preview (`0.1`)** | `1.0 Stable Candidate` | Package manifest metadata |

---

### 3.2 Beta (Integration-Verified) (7 Packages, 28 Exports)

#### `@bunest/cache` (`0.1.0` — 3 exports)

| Export Subpath | Source Entry | Stability Tier | `1.0` Target | Notes / Scope |
| --- | --- | --- | --- | --- |
| `@bunest/cache` (`.`) | `./src/index.ts` | **Beta (Integration-Verified)** | `0.2.x` promotion candidate | `CacheModule`, `CacheService`, `CacheInterceptor`, `@Cacheable`/`@CacheEvict`/`@CachePut`, `MemoryCacheStore` |
| `@bunest/cache/redis` | `./src/redis/index.ts` | **Beta (Integration-Verified)** | `0.2.x` promotion candidate | `RedisCacheStore` (`Bun.RedisClient`); production promotion requires real-Redis outage/reconnect verification |
| `@bunest/cache/package.json` | `./package.json` | **Beta (Integration-Verified)** | `0.2.x` promotion candidate | Package manifest metadata |

#### `@bunest/jobs` (`0.1.0` — 5 exports)

| Export Subpath | Source Entry | Stability Tier | `1.0` Target | Notes / Scope |
| --- | --- | --- | --- | --- |
| `@bunest/jobs` (`.`) | `./src/index.ts` | **Beta (Integration-Verified)** | `0.2.x` promotion candidate | Unified queue + scheduler entry |
| `@bunest/jobs/queues` | `./src/queues/index.ts` | **Beta (Integration-Verified)** | `0.2.x` promotion candidate | `QueueModule`, `BullModule`/`BullMQModule`, `@Processor`, `WorkerHost`, `FlowProducer`, retries/DLQ |
| `@bunest/jobs/scheduler` | `./src/scheduler/index.ts` | **Beta (Integration-Verified)** | `0.2.x` promotion candidate | `ScheduleModule`, `@Cron`, `@Interval`, `@Timeout` |
| `@bunest/jobs/redis` | `./src/redis/index.ts` | **Beta (Integration-Verified)** | `0.2.x` promotion candidate | Atomic Lua `RedisQueueDriver` (`Bun.RedisClient`); production promotion requires real-Redis crash/lease-expiry/redelivery tests |
| `@bunest/jobs/package.json` | `./package.json` | **Beta (Integration-Verified)** | `0.2.x` promotion candidate | Package manifest metadata |

#### `@bunest/security` (`0.1.0` — 7 exports)

| Export Subpath | Source Entry | Stability Tier | `1.0` Target | Notes / Scope |
| --- | --- | --- | --- | --- |
| `@bunest/security` (`.`) | `./src/index.ts` | **Beta (Integration-Verified)** | `0.2.x` / `1.0` candidate | `SecurityModule.forRoot()`, `PassportModule`, `Bun.password`, `Bun.CSRF`, security headers |
| `@bunest/security/auth` | `./src/auth-next/index.ts` | **Beta (Integration-Verified)** | `0.2.x` / `1.0` candidate | `@Auth()`, `@Protected()`, sessions, refresh-token families, TOTP MFA, magic links, OIDC/OAuth2, API keys |
| `@bunest/security/authz` | `./src/authz/index.ts` | **Beta (Integration-Verified)** | `0.2.x` / `1.0` candidate | Policy-based authorization (`@Policy()`, `@Can()`) |
| `@bunest/security/jwt` | `./src/jwt/index.ts` | **Beta (Integration-Verified)** | `0.2.x` / `1.0` candidate | WebCrypto `JwtModule`, `JwtService`, `JwksModule` |
| `@bunest/security/throttler` | `./src/throttler/index.ts` | **Beta (Integration-Verified)** | `0.2.x` / `1.0` candidate | `ThrottlerModule`, rate-limiting guards & decorators |
| `@bunest/security/testing` | `./src/auth-next/testing/index.ts` | **Beta (Integration-Verified)** | `0.2.x` / `1.0` candidate | Authentication & session test fixtures |
| `@bunest/security/package.json` | `./package.json` | **Beta (Integration-Verified)** | `0.2.x` / `1.0` candidate | Package manifest metadata |

#### `@bunest/swagger` (`0.1.0` — 2 exports)

| Export Subpath | Source Entry | Stability Tier | `1.0` Target | Notes / Scope |
| --- | --- | --- | --- | --- |
| `@bunest/swagger` (`.`) | `./src/index.ts` | **Beta (Integration-Verified)** | `0.2.x` / `1.0` candidate | OpenAPI 3.1 `DocumentBuilder`, `SwaggerModule`, `@Api*` decorators, Swagger UI / Scalar |
| `@bunest/swagger/package.json` | `./package.json` | **Beta (Integration-Verified)** | `0.2.x` / `1.0` candidate | Package manifest metadata |

#### `@bunest/testing` (`0.1.0` — 2 exports)

| Export Subpath | Source Entry | Stability Tier | `1.0` Target | Notes / Scope |
| --- | --- | --- | --- | --- |
| `@bunest/testing` (`.`) | `./src/index.ts` | **Beta (Integration-Verified)** | `1.0 Stable Candidate` | `Test.createTestingModule`, overrides, `ModuleMocker`, `request(app)`, `TestClient`, `CapturingLogger` |
| `@bunest/testing/package.json` | `./package.json` | **Beta (Integration-Verified)** | `1.0 Stable Candidate` | Package manifest metadata |

#### `@bunest/cli` (`0.1.0` — 3 exports)

| Export Subpath | Source Entry | Stability Tier | `1.0` Target | Notes / Scope |
| --- | --- | --- | --- | --- |
| `@bunest/cli` (`.`) | `./src/index.ts` | **Beta (Integration-Verified)** | `1.0 Stable Candidate` | Programmatic CLI runner, schematics, `bunestMetadataPlugin()` |
| `@bunest/cli/analyzer` | `./src/analyzer/index.ts` | **Beta (Integration-Verified)** | `1.0 Stable Candidate` | Static diagnostics (`BUNEST*`) & project graph analyzer |
| `@bunest/cli/package.json` | `./package.json` | **Beta (Integration-Verified)** | `1.0 Stable Candidate` | Package manifest metadata |

#### `@bunest/resilience` (`0.1.0` — 6 exports)

| Export Subpath | Source Entry | Stability Tier | `1.0` Target | Notes / Scope |
| --- | --- | --- | --- | --- |
| `@bunest/resilience` (`.`) | `./src/index.ts` | **Beta (Integration-Verified)** | `0.2.x` / `1.0` candidate | `@Retry`, `@Timeout`, `@CircuitBreaker`, `@Bulkhead`, `@RateLimit`, `@Fallback` |
| `@bunest/resilience/locks` | `./src/locks/index.ts` | **Beta (Integration-Verified)** | `0.2.x` / `1.0` candidate | Distributed leased locks, fencing tokens, `@WithLock()`, `@OnOneInstance()` |
| `@bunest/resilience/locks/testing` | `./src/locks/testing/index.ts` | **Beta (Integration-Verified)** | `0.2.x` / `1.0` candidate | In-memory lock test doubles |
| `@bunest/resilience/idempotency` | `./src/idempotency/index.ts` | **Beta (Integration-Verified)** | `0.2.x` / `1.0` candidate | `@Idempotent()` safe retry deduplication |
| `@bunest/resilience/idempotency/testing` | `./src/idempotency/testing/index.ts` | **Beta (Integration-Verified)** | `0.2.x` / `1.0` candidate | Idempotency store test doubles |
| `@bunest/resilience/package.json` | `./package.json` | **Beta (Integration-Verified)** | `0.2.x` / `1.0` candidate | Package manifest metadata |

---

### 3.3 Preview / Experimental (8 Packages, 41 Exports)

#### `@bunest/ai` (`0.1.0` — 6 exports)

| Export Subpath | Source Entry | Stability Tier | `1.0` Target | Notes / Scope |
| --- | --- | --- | --- | --- |
| `@bunest/ai` (`.`) | `./src/index.ts` | **Preview / Experimental** | `0.2.x+` evaluation | Native `fetch()` SSE clients (OpenAI, Anthropic, Gemini), `generateText`, `generateObject`, `streamText`, `@AgentFunction` |
| `@bunest/ai/testing` | `./src/testing/index.ts` | **Preview / Experimental** | `0.2.x+` evaluation | Mock LLM providers & deterministic streaming fixtures |
| `@bunest/ai/workflows` | `./src/workflows/index.ts` | **Preview / Experimental** | `0.2.x+` evaluation | Durable agent workflow integration |
| `@bunest/ai/mcp` | `./src/mcp/index.ts` | **Preview / Experimental** | `0.2.x+` evaluation | Model Context Protocol server (`@Tool`, `@Resource`, `@ResourceTemplate`, `@Prompt`) |
| `@bunest/ai/mcp/testing` | `./src/mcp/testing/index.ts` | **Preview / Experimental** | `0.2.x+` evaluation | MCP JSON-RPC test harness |
| `@bunest/ai/package.json` | `./package.json` | **Preview / Experimental** | `0.2.x+` evaluation | Package manifest metadata |

#### `@bunest/elasticsearch` (`0.1.0` — 2 exports)

| Export Subpath | Source Entry | Stability Tier | `1.0` Target | Notes / Scope |
| --- | --- | --- | --- | --- |
| `@bunest/elasticsearch` (`.`) | `./src/index.ts` | **Preview / Experimental** | `0.2.x+` evaluation | `ElasticsearchModule` & native Bun `fetch()` REST client |
| `@bunest/elasticsearch/package.json` | `./package.json` | **Preview / Experimental** | `0.2.x+` evaluation | Package manifest metadata |

#### `@bunest/graphql` (`0.1.0` — 3 exports)

| Export Subpath | Source Entry | Stability Tier | `1.0` Target | Notes / Scope |
| --- | --- | --- | --- | --- |
| `@bunest/graphql` (`.`) | `./src/index.ts` | **Preview / Experimental** | `0.2.x+` evaluation | Code-first & schema-first GraphQL, `BunestDataLoader`, PubSub & SSE/`graphql-ws` subscriptions |
| `@bunest/graphql/apollo` | `./src/apollo/index.ts` | **Preview / Experimental** | `0.2.x+` evaluation | `ApolloDriver`, Federation v2 Subgraph & Gateway drivers |
| `@bunest/graphql/package.json` | `./package.json` | **Preview / Experimental** | `0.2.x+` evaluation | Package manifest metadata |

#### `@bunest/mail` (`0.1.0` — 4 exports)

| Export Subpath | Source Entry | Stability Tier | `1.0` Target | Notes / Scope |
| --- | --- | --- | --- | --- |
| `@bunest/mail` (`.`) | `./src/index.ts` | **Preview / Experimental** | `0.2.x+` evaluation | `MailModule`, typed mail classes, Resend / Postmark / SendGrid / SES transports |
| `@bunest/mail/smtp` | `./src/smtp/index.ts` | **Preview / Experimental** | `0.2.x+` evaluation | Native Bun SMTP transport |
| `@bunest/mail/templates` | `./src/templates/index.ts` | **Preview / Experimental** | `0.2.x+` evaluation | Auto-escaped `Bun.escapeHTML` mail template helpers |
| `@bunest/mail/package.json` | `./package.json` | **Preview / Experimental** | `0.2.x+` evaluation | Package manifest metadata |

#### `@bunest/messaging` (`0.1.0` — 12 exports)

| Export Subpath | Source Entry | Stability Tier | `1.0` Target | Notes / Scope |
| --- | --- | --- | --- | --- |
| `@bunest/messaging` (`.`) | `./src/index.ts` | **Preview / Experimental** | `0.2.x+` evaluation | Unified messaging barrel |
| `@bunest/messaging/events` | `./src/events/index.ts` | **Preview / Experimental** | `0.2.x+` evaluation | `EventEmitterModule` / `@OnEvent()` |
| `@bunest/messaging/cqrs` | `./src/cqrs/index.ts` | **Preview / Experimental** | `0.2.x+` evaluation | `CqrsModule`, `CommandBus`, `QueryBus`, `EventBus`, Sagas |
| `@bunest/messaging/outbox` | `./src/outbox/index.ts` | **Preview / Experimental** | `0.2.x+` evaluation | Transactional Outbox & Consumer Inbox |
| `@bunest/messaging/outbox/testing` | `./src/outbox/testing/index.ts` | **Preview / Experimental** | `0.2.x+` evaluation | Outbox/Inbox in-memory test doubles |
| `@bunest/messaging/outbox/postgres` | `./src/outbox/postgres/index.ts` | **Preview / Experimental** | `0.2.x+` evaluation | PostgreSQL Outbox/Inbox store |
| `@bunest/messaging/outbox/mysql` | `./src/outbox/mysql/index.ts` | **Preview / Experimental** | `0.2.x+` evaluation | MySQL Outbox/Inbox store |
| `@bunest/messaging/webhooks` | `./src/webhooks/index.ts` | **Preview / Experimental** | `0.2.x+` evaluation | Outbound/Inbound webhooks, HMAC-SHA256, SSRF `AddressPolicy`, AES-256-GCM sealing |
| `@bunest/messaging/webhooks/testing` | `./src/webhooks/testing/index.ts` | **Preview / Experimental** | `0.2.x+` evaluation | Webhook store & signer test doubles |
| `@bunest/messaging/webhooks/postgres` | `./src/webhooks/postgres/index.ts` | **Preview / Experimental** | `0.2.x+` evaluation | PostgreSQL Webhook store |
| `@bunest/messaging/webhooks/mysql` | `./src/webhooks/mysql/index.ts` | **Preview / Experimental** | `0.2.x+` evaluation | MySQL Webhook store |
| `@bunest/messaging/package.json` | `./package.json` | **Preview / Experimental** | `0.2.x+` evaluation | Package manifest metadata |

#### `@bunest/microservices` (`0.1.0` — 2 exports)

| Export Subpath | Source Entry | Stability Tier | `1.0` Target | Notes / Scope |
| --- | --- | --- | --- | --- |
| `@bunest/microservices` (`.`) | `./src/index.ts` | **Preview / Experimental** | `0.2.x+` evaluation | `@MessagePattern`, `@EventPattern`, `@GrpcMethod`, `ClientProxy`, TCP / InMemory / Redis / NATS / RabbitMQ / Kafka / MQTT / gRPC |
| `@bunest/microservices/package.json` | `./package.json` | **Preview / Experimental** | `0.2.x+` evaluation | Package manifest metadata |

#### `@bunest/storage` (`0.1.0` — 5 exports)

| Export Subpath | Source Entry | Stability Tier | `1.0` Target | Notes / Scope |
| --- | --- | --- | --- | --- |
| `@bunest/storage` (`.`) | `./src/index.ts` | **Preview / Experimental** | `0.2.x+` evaluation | `StorageModule`, unified disk interface, signed URLs |
| `@bunest/storage/s3` | `./src/s3/index.ts` | **Preview / Experimental** | `0.2.x+` evaluation | Native `BunS3Disk` (`Bun.S3Client`) & SigV4 `S3Disk` (S3/R2/MinIO) |
| `@bunest/storage/local` | `./src/local/index.ts` | **Preview / Experimental** | `0.2.x+` evaluation | `LocalDisk` (`Bun.file().slice().stream()`) |
| `@bunest/storage/memory` | `./src/memory/index.ts` | **Preview / Experimental** | `0.2.x+` evaluation | `InMemoryDisk` for testing & ephemeral storage |
| `@bunest/storage/package.json` | `./package.json` | **Preview / Experimental** | `0.2.x+` evaluation | Package manifest metadata |

#### `@bunest/workflows` (`0.1.0` — 7 exports)

| Export Subpath | Source Entry | Stability Tier | `1.0` Target | Notes / Scope |
| --- | --- | --- | --- | --- |
| `@bunest/workflows` (`.`) | `./src/index.ts` | **Preview / Experimental** | `0.2.x+` evaluation | Durable workflows module, replay, signals, timers, sagas, schedules |
| `@bunest/workflows/core` | `./src/core/index.ts` | **Preview / Experimental** | `0.2.x+` evaluation | Framework-agnostic durable workflow runtime primitives |
| `@bunest/workflows/cqrs` | `./src/cqrs/index.ts` | **Preview / Experimental** | `0.2.x+` evaluation | CQRS integration for workflow commands/events |
| `@bunest/workflows/postgres` | `./src/postgres/index.ts` | **Preview / Experimental** | `0.2.x+` evaluation | PostgreSQL durable workflow store |
| `@bunest/workflows/mysql` | `./src/mysql/index.ts` | **Preview / Experimental** | `0.2.x+` evaluation | MySQL durable workflow store |
| `@bunest/workflows/testing` | `./src/testing/index.ts` | **Preview / Experimental** | `0.2.x+` evaluation | Deterministic workflow test harness |
| `@bunest/workflows/package.json` | `./package.json` | **Preview / Experimental** | `0.2.x+` evaluation | Package manifest metadata |

---

## 4. SemVer Compatibility & Deprecation Policy (`0.1.x` → `0.2.x` → `1.0`)

### 4.1 Release Line Guarantees

| Release Line | Patch (`x.y.Z`) | Minor (`x.Y.0`) | Major (`X.0.0`) | Minimum Bun Bump |
| --- | --- | --- | --- | --- |
| **`0.1.x` (Production Preview)** | Strictly backward-compatible bug fixes, security patches, and additive docs/tests. Existing `0.1.0` apps must upgrade in place without code changes. | N/A (moves to `0.2.0`) | N/A | Forbidden in `0.1.x` patches |
| **`0.2.x` – `0.9.x` (Pre-1.0 Minor Cycles)** | Strictly backward-compatible fixes only. | May promote Beta/Preview modules and introduce controlled breaking changes **only** when backed by an ADR (`docs/adr/`), `CHANGELOG.md` migration notes, and a prior deprecation notice where practical. | N/A | Allowed on minor release (`0.Y.0`) with release notes |
| **`1.0.0+` (General Availability)** | Strictly backward-compatible bug fixes and security patches. | Strictly backward-compatible new features and module promotions on all **Stable** `package.json#exports`. | Breaking changes to Stable public exports (with codemods or migration guides). | Requires major release if breaking |

### 4.2 Deprecation Lifecycle

1. **Announcement**: Mark the symbol or subpath with a `@deprecated` JSDoc tag specifying the replacement and target removal version, and record it under **Deprecated** in [`CHANGELOG.md`](../CHANGELOG.md).
2. **Diagnostic Signal**: Where applicable, emit a static diagnostic (`BUNEST*` via `@bunest/cli/analyzer`) or one-time startup warning with actionable fix instructions.
3. **Grace Period**:
   - In **`0.1.x` → `0.2.x`**: Production Preview exports receive at least one patch/minor notice and a written migration path before removal or signature change; any core contract change requires an ADR in `docs/adr/`.
   - In **`1.0.0+`**: Deprecated Stable exports remain functional for **at least one minor release** (or **6 months** on LTS lines) before removal in the next major release (`2.0.0+`).
4. **Upgrade Verification**: Every release candidate in `0.1.x`, `0.2.x`, and `1.0.0-rc` is verified by upgrading an out-of-monorepo pilot application across consecutive versions (see Week 5 & Section 6 of [`docs/ke-hoach-phat-trien-bunest.md`](./ke-hoach-phat-trien-bunest.md)).

### 4.3 Module Promotion Gate (`Preview` → `Beta` → `Production Preview` / `1.0 Stable`)

No package or subpath is promoted based on unit or NestJS conformance test counts alone:

- **`Preview / Experimental` → `Beta`**: 100% unit/conformance coverage + automated real-service integration tests in CI + documented public subpath contract.
- **`Beta` → `Production Preview` / `1.0 Stable`**: Dedicated real-infrastructure fault-injection and soak verification, operational runbook (including failure/redelivery semantics), out-of-monorepo clean-install & upgrade proof, and a designated module maintainer.
