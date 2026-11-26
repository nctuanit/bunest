# Bunest Public API Matrix & Stability Contract

This document is the authoritative inventory of every public package and `package.json#exports` entrypoint shipped by the Bunest monorepo (**19 lockstep-versioned `@bunest/*` packages**, **95 declared `exports` keys**: **76** runtime/type entrypoints — 19 root `.` + 57 named subpaths — plus **19** `./package.json` metadata exports).

Every stability tier, owner assignment, and promotion/freeze gate below is aligned 1:1 with [`docs/support-policy.md`](./support-policy.md), [`docs/production-preview.md`](./production-preview.md), [`docs/security.md`](./security.md), and [`docs/ke-hoach-phat-trien-bunest.md`](./ke-hoach-phat-trien-bunest.md) (§4 & §9).

---

## 1. Public API Boundary

- **Public contract**: Only symbols re-exported from the declared `package.json#exports` entrypoints listed in this document are part of Bunest's public API.
- **Internal files**: Importing directly from `src/*`, `dist/*`, or any undeclared path is unsupported and may break in any patch release.
- **Zero external runtime dependencies (`ADR-017`)**: All 19 `@bunest/*` packages ship with `0` third-party runtime dependencies and target **Bun `>= 1.4.5`**.
- **Lockstep versioning**: All 19 packages share the exact same version number on every release (currently `0.1.0`).

---

## 2. Stability Tier Summary & Ownership Key

| Stability Tier | Target for `1.0` | Packages (19 total) | Qualification Criteria |
| --- | --- | --- | --- |
| **Production Preview (`0.1`)** | **`1.0 Stable Candidate`** | `@bunest/core` (HTTP, DI, Config), `@bunest/validation`, `@bunest/orm` (PostgreSQL via `Bun.SQL`, explicit migrations), `@bunest/observability` (logging, health, metrics) — **4 packages** | Pinned Linux CI (`Bun 1.4.5`) green, real PostgreSQL persistence/migration/outage/backup smoke suite, 2h soak gate (`p95 < 200 ms`, `5xx < 0.1%`, stable RSS), `< 5 min` rollback rehearsal, clean out-of-repo registry install & upgrade. |
| **Beta (Integration-Verified)** | Promoted per module in `0.2.x+` or `1.0` | `@bunest/cache`, `@bunest/jobs`, `@bunest/security`, `@bunest/swagger`, `@bunest/testing`, `@bunest/cli`, `@bunest/resilience` (+ `@bunest/orm` SQLite, non-preview subpaths of `@bunest/core` / `@bunest/observability`) — **7 packages** | Full unit & conformance coverage + real-service integration tests (Redis / SQLite) in CI. |
| **Preview / Experimental** | Promoted on real-infrastructure verification | `@bunest/ai`, `@bunest/elasticsearch`, `@bunest/graphql`, `@bunest/mail`, `@bunest/messaging`, `@bunest/microservices`, `@bunest/storage`, `@bunest/workflows` (+ `@bunest/core/ws`, non-PostgreSQL `Bun.SQL` dialects) — **8 packages** | Functional with 100% conformance / unit tests; awaiting dedicated real-service fault-injection & soak verification before promotion. |

### Ownership Key (Aligned with [`docs/ke-hoach-phat-trien-bunest.md`](./ke-hoach-phat-trien-bunest.md) §4 & §9)

| Owner Group | Maintainer Role | Primary Scope |
| --- | --- | --- |
| **Core & DX** | Person A (Framework & DX) | `@bunest/core`, `@bunest/validation`, `@bunest/testing`, `@bunest/cli`, `@bunest/swagger` — DI, HTTP, validation, CLI, quickstart, public API contract, and migration guides. |
| **Data & Release** | Person B (Data & Release) | `@bunest/orm`, `@bunest/cache`, `@bunest/jobs` — PostgreSQL/SQLite persistence, migrations, Redis integration, staging registry, load/soak, and rollback. |
| **Security & Ops** | Person A + Person B (Security & Ops) | `@bunest/observability`, `@bunest/security`, `@bunest/resilience` — logging/health/metrics, WebCrypto auth/authz, rate limiting, locks/idempotency, and `1.0` RC security audit triage. |
| **Ecosystem** | Pilot-Driven Maintainers | `@bunest/ai`, `@bunest/elasticsearch`, `@bunest/graphql`, `@bunest/mail`, `@bunest/messaging`, `@bunest/microservices`, `@bunest/storage`, `@bunest/workflows` — promoted individually when backed by pilot demand and real-infrastructure tests. |

---

## 3. Complete Package & Subpath Inventory (19 Packages, 95 Exports)

> **Export counts**: Each package exposes a root `.` entrypoint, optional named ESM subpaths, and `./package.json` for tooling introspection. Totals: **19** root `.` + **57** named subpaths = **76** code entrypoints, plus **19** `./package.json` metadata exports (**95** total `package.json#exports` keys).

### 3.1 Production Preview (`0.1`) → `1.0 Stable Candidate` (4 Packages, 26 Exports)

#### `@bunest/core` (`0.1.0` — 8 exports)

| Export Subpath | Source Entry | Owner | Stability Tier | `1.0` Target | Guaranteed Behavior | Corresponding Docs |
| --- | --- | --- | --- | --- | --- | --- |
| `@bunest/core` (`.`) | `./src/index.ts` | Core & DX | **Production Preview (`0.1`)** | `1.0 Stable Candidate` | Deterministic `@Module()` graph resolution, Singleton/Request/Transient DI scopes, ordered lifecycle hooks (`onModuleInit` → `onApplicationBootstrap` → `beforeApplicationShutdown` → `onApplicationShutdown`), `BunestFactory.create()` bootstrap with stable `BUNEST_E*` diagnostics, and `MethodAspectWeaver` Promise-based AOP. | [README](../packages/core/README.md) · [Modules](../apps/docs/content/overview/modules.md) · [Architecture](./architecture.md) · [Errors](./errors.md) |
| `@bunest/core/common` | `./src/common/index.ts` | Core & DX | **Production Preview (`0.1`)** | `1.0 Stable Candidate` | NestJS-compatible decorators, `HttpException` hierarchy with production error redaction (`ADR-008`), `Reflector`, `Logger` with deep secret redaction, and Promise-only `ExecutionContext` / guard / interceptor / pipe / filter contracts. | [README](../packages/core/README.md) · [Decorators](../apps/docs/content/overview/decorators.md) · [Execution Pipeline](../apps/docs/content/architecture/execution-pipeline.md) |
| `@bunest/core/http` | `./src/http/index.ts` | Core & DX | **Production Preview (`0.1`)** | `1.0 Stable Candidate` | `BunHttpAdapter` hybrid `Bun.serve` + `FallbackRadixRouter` preserving exact 11-stage HTTP pipeline order, `bodyLimit` `413` enforcement, malformed JSON/multipart `400` mapping, prototype-pollution key sanitization, CORS error preservation, explicit `trustProxy`, and graceful `SIGTERM` request draining. | [README](../packages/core/README.md) · [Hybrid Router](../apps/docs/content/architecture/hybrid-router.md) · [Security Guide](./security.md) |
| `@bunest/core/config` | `./src/config/index.ts` | Core & DX | **Production Preview (`0.1`)** | `1.0 Stable Candidate` | `ConfigModule` / `ConfigService` deterministic `.env` / YAML / TOML / JSONC loading, dangerous-key stripping during merge, typed `getOrThrow()`, and `createSecretRedactor()` non-mutating redaction. | [README](../packages/core/README.md) · [Configuration](../apps/docs/content/techniques/configuration.md) |
| `@bunest/core/client` | `./src/client/index.ts` | Core & DX | **Beta (Integration-Verified)** | `1.0 Candidate (post-pilot)` | Zero-dep `fetch()` `HttpModule` / `HttpService` returning Promises with request/response interceptors, timeout abort signals, and explicit redirect/error handling. | [README](../packages/core/README.md) · [HTTP Client](../apps/docs/content/techniques/http-client.md) |
| `@bunest/core/i18n` | `./src/i18n/index.ts` | Core & DX | **Beta (Integration-Verified)** | `1.0 Candidate (post-pilot)` | `AsyncLocalStorage`-backed `I18nModule` preserving per-request locale isolation across async boundaries with deterministic fallback locale resolution. | [README](../packages/core/README.md) · [i18n](../apps/docs/content/techniques/i18n.md) |
| `@bunest/core/ws` | `./src/ws/index.ts` | Core & DX | **Preview / Experimental** | `0.2.x+` evaluation | Native Bun WebSocket gateways (`@WebSocketGateway`, `@SubscribeMessage`) with frame sanitization; excluded from `0.1` production preview SLA until multi-instance soak testing. | [README](../packages/core/README.md) · [WebSockets](../apps/docs/content/apis/websockets.md) *(dedicated production guide planned for `0.2.x+`)* |
| `@bunest/core/package.json` | `./package.json` | Core & DX | **Production Preview (`0.1`)** | `1.0 Stable Candidate` | Exposes valid JSON package manifest metadata (`name`, `version`, `exports`, `engines.bun`) for runtime and CLI introspection. | [README](../packages/core/README.md) · [Public API Matrix](./public-api-matrix.md) |

#### `@bunest/validation` (`0.1.0` — 5 exports)

| Export Subpath | Source Entry | Owner | Stability Tier | `1.0` Target | Guaranteed Behavior | Corresponding Docs |
| --- | --- | --- | --- | --- | --- | --- |
| `@bunest/validation` (`.`) | `./src/index.ts` | Core & DX | **Production Preview (`0.1`)** | `1.0 Stable Candidate` | `ValidationPipe` defaults to `whitelist: true`, `forbidNonWhitelisted: true`, `forbidUnknownValues: true`, `enableImplicitConversion: false`, and `validationError: { target: false, value: false }` (`ADR-009`), returning deterministic HTTP `400` payloads; includes `ClassSerializerInterceptor` and mapped DTO helpers (`PartialType`, `PickType`, `OmitType`, `IntersectionType`). | [README](../packages/validation/README.md) · [Validation](../apps/docs/content/techniques/validation.md) · [Mapped Types](../apps/docs/content/techniques/mapped-types.md) · [ADR-009](./adr/ADR-009.md) |
| `@bunest/validation/validator` | `./src/validator/index.ts` | Core & DX | **Production Preview (`0.1`)** | `1.0 Stable Candidate` | Zero-dep compile-once DTO validator (`ADR-015`) with `class-validator` decorator parity, nested/array validation, and dangerous-key (`__proto__`, `constructor`, `prototype`) stripping/rejection. | [README](../packages/validation/README.md) · [Validation](../apps/docs/content/techniques/validation.md) · [ADR-015](./adr/ADR-015.md) |
| `@bunest/validation/transformer` | `./src/transformer/index.ts` | Core & DX | **Production Preview (`0.1`)** | `1.0 Stable Candidate` | Zero-dep DTO transformer (`ADR-015`) with `class-transformer` parity (`plainToInstance`, `instanceToPlain`, `@Expose`, `@Exclude`, `@Type`), never mutating caller input objects or assigning prototype keys. | [README](../packages/validation/README.md) · [Serialization](../apps/docs/content/techniques/serialization.md) · [ADR-015](./adr/ADR-015.md) |
| `@bunest/validation/standard-schema` | `./src/standard-schema/index.ts` | Core & DX | **Production Preview (`0.1`)** | `1.0 Stable Candidate` | `StandardSchemaV1` / `StandardSchemaValidationPipe` adapter validating any Standard Schema v1 library and normalizing failures to Bunest `BadRequestException` (`400`) without leaking raw values. | [README](../packages/validation/README.md) · [Validation](../apps/docs/content/techniques/validation.md) *(dedicated Standard Schema subpath guide planned for `1.0`)* |
| `@bunest/validation/package.json` | `./package.json` | Core & DX | **Production Preview (`0.1`)** | `1.0 Stable Candidate` | Exposes valid JSON package manifest metadata for runtime and CLI introspection. | [README](../packages/validation/README.md) · [Public API Matrix](./public-api-matrix.md) |

#### `@bunest/orm` (`0.1.0` — 7 exports)

| Export Subpath | Source Entry | Owner | Stability Tier | `1.0` Target | Guaranteed Behavior | Corresponding Docs |
| --- | --- | --- | --- | --- | --- | --- |
| `@bunest/orm` (`.`) | `./src/index.ts` | Data & Release | **Production Preview (`0.1`)** *(PostgreSQL)* | `1.0 Stable Candidate` *(PostgreSQL)* | Parameterized `Bun.SQL` queries, atomic transaction rollback on thrown errors, explicit forward migrations (`synchronize: false`), and automatic pool recovery after PostgreSQL outage; SQLite is **Beta**, other dialects are **Preview / Experimental**. | [README](../packages/orm/README.md) · [SQL Guide](../apps/docs/content/data/sql.md) · [SQLite](../apps/docs/content/data/sqlite.md) · [Production Preview](./production-preview.md) |
| `@bunest/orm/postgres` | `./src/store-kit/postgres/index.ts` | Data & Release | **Production Preview (`0.1`)** | `1.0 Stable Candidate` | PostgreSQL SQL Store Kit primitives with safe identifier quoting, parameterized `$1..$n` bindings, and `Bun.SQL` transaction propagation. | [README](../packages/orm/README.md) · [Store Kit](../apps/docs/content/data/store-kit.md) |
| `@bunest/orm/store` | `./src/store-kit/index.ts` | Data & Release | **Production Preview (`0.1`)** *(PostgreSQL)* | `1.0 Stable Candidate` *(PostgreSQL)* | Shared SQL Store Kit (`createBunSqlExecutor`) unifying query execution and transaction scoping across dialects; PostgreSQL path is Production Preview, MySQL path is Preview / Experimental. | [README](../packages/orm/README.md) · [Store Kit](../apps/docs/content/data/store-kit.md) |
| `@bunest/orm/plugin` | `./src/plugin.ts` | Data & Release | **Beta (Integration-Verified)** | `1.0 Candidate (post-pilot)` | Stable ORM dialect/adapter plugin registration contract (`ADR-018`) isolating dialect hooks without breaking core repository APIs. | [README](../packages/orm/README.md) · [ORM Adapters](../apps/docs/content/data/orm-adapters.md) · [ADR-018](./adr/ADR-018.md) |
| `@bunest/orm/testing` | `./src/store-kit/testing/index.ts` | Data & Release | **Beta (Integration-Verified)** | `1.0 Candidate (post-pilot)` | Deterministic in-memory Store Kit test helpers for unit-testing repositories and SQL stores without external DB servers. | [README](../packages/orm/README.md) · [Store Kit](../apps/docs/content/data/store-kit.md) *(dedicated testing subpath guide planned for `0.2.x`)* |
| `@bunest/orm/mysql` | `./src/store-kit/mysql/index.ts` | Data & Release | **Preview / Experimental** | `0.2.x+` evaluation | MySQL SQL Store Kit dialect primitives; excluded from `0.1` production preview until real-MySQL persistence/outage verification. | [README](../packages/orm/README.md) · [Store Kit](../apps/docs/content/data/store-kit.md) *(dedicated MySQL guide planned for `0.2.x+`)* |
| `@bunest/orm/package.json` | `./package.json` | Data & Release | **Production Preview (`0.1`)** | `1.0 Stable Candidate` | Exposes valid JSON package manifest metadata for runtime and CLI introspection. | [README](../packages/orm/README.md) · [Public API Matrix](./public-api-matrix.md) |

#### `@bunest/observability` (`0.1.0` — 6 exports)

| Export Subpath | Source Entry | Owner | Stability Tier | `1.0` Target | Guaranteed Behavior | Corresponding Docs |
| --- | --- | --- | --- | --- | --- | --- |
| `@bunest/observability` (`.`) | `./src/index.ts` | Security & Ops | **Production Preview (`0.1`)** | `1.0 Stable Candidate` | `ObservabilityModule.forRoot()` emitting structured JSON logs with request correlation IDs and deep secret redaction (`password`, `secret`, `token`, `authorization`, `cookie`, etc.) without mutating caller objects. | [README](../packages/observability/README.md) · [Observability](../apps/docs/content/observability/observability.md) · [Production Preview](./production-preview.md) |
| `@bunest/observability/health` | `./src/health/index.ts` | Security & Ops | **Production Preview (`0.1`)** | `1.0 Stable Candidate` | `TerminusModule` / `HealthModule` separating liveness (`/live` stays `200` while process is healthy) from readiness (`/ready` transitions `200 → 503 → 200` across dependency outages without restart), plus native `Bun.connect()` TCP indicators. | [README](../packages/observability/README.md) · [Observability](../apps/docs/content/observability/observability.md) · [Production Preview](./production-preview.md) |
| `@bunest/observability/metrics` | `./src/metrics/index.ts` | Security & Ops | **Production Preview (`0.1`)** | `1.0 Stable Candidate` | Internal Prometheus text exposition (`/metrics`), `@Timed`, and `@Counted` with bounded label cardinality and optional bearer-token protection. | [README](../packages/observability/README.md) · [Observability](../apps/docs/content/observability/observability.md) |
| `@bunest/observability/tracing` | `./src/tracing/index.ts` | Security & Ops | **Beta (Integration-Verified)** | `1.0 Candidate (post-pilot)` | W3C `traceparent`/`tracestate`/`baggage` propagation with prototype-pollution-safe header parsing, `@Span`/`@Trace` decorators, and non-blocking OTLP HTTP export. | [README](../packages/observability/README.md) · [Observability](../apps/docs/content/observability/observability.md) *(dedicated tracing subpath guide planned for `0.2.x`)* |
| `@bunest/observability/devtools` | `./src/devtools/index.ts` | Security & Ops | **Beta (Integration-Verified)** | `1.0 Candidate (post-pilot)` | `DevtoolsModule` DI/module graph introspection endpoints (`/_devtools/*`), guaranteed disabled by default whenever `NODE_ENV === "production"`. | [README](../packages/observability/README.md) · [Security Guide](./security.md) *(dedicated devtools subpath guide planned for `1.0`)* |
| `@bunest/observability/package.json` | `./package.json` | Security & Ops | **Production Preview (`0.1`)** | `1.0 Stable Candidate` | Exposes valid JSON package manifest metadata for runtime and CLI introspection. | [README](../packages/observability/README.md) · [Public API Matrix](./public-api-matrix.md) |

---

### 3.2 Beta (Integration-Verified) (7 Packages, 28 Exports)

#### `@bunest/cache` (`0.1.0` — 3 exports)

| Export Subpath | Source Entry | Owner | Stability Tier | `1.0` Target | Guaranteed Behavior | Corresponding Docs |
| --- | --- | --- | --- | --- | --- | --- |
| `@bunest/cache` (`.`) | `./src/index.ts` | Data & Release | **Beta (Integration-Verified)** | `0.2.x` promotion candidate | `CacheModule`, `CacheService`, `@Cacheable`/`@CacheEvict`/`@CachePut`, `MemoryCacheStore` with TTL expiry, and `CacheInterceptor` that bypasses caching when responses include `Set-Cookie` or `Cache-Control: private` / `no-store`. | [README](../packages/cache/README.md) · [Caching](../apps/docs/content/techniques/caching.md) |
| `@bunest/cache/redis` | `./src/redis/index.ts` | Data & Release | **Beta (Integration-Verified)** | `0.2.x` promotion candidate | `RedisCacheStore` backed by native `Bun.RedisClient` with key prefix isolation and TTL enforcement; production promotion gated on real-Redis outage/reconnect verification. | [README](../packages/cache/README.md) · [Caching](../apps/docs/content/techniques/caching.md) *(dedicated Redis ops guide planned for `0.2.x`)* |
| `@bunest/cache/package.json` | `./package.json` | Data & Release | **Beta (Integration-Verified)** | `0.2.x` promotion candidate | Exposes valid JSON package manifest metadata for runtime and CLI introspection. | [README](../packages/cache/README.md) · [Public API Matrix](./public-api-matrix.md) |

#### `@bunest/jobs` (`0.1.0` — 5 exports)

| Export Subpath | Source Entry | Owner | Stability Tier | `1.0` Target | Guaranteed Behavior | Corresponding Docs |
| --- | --- | --- | --- | --- | --- | --- |
| `@bunest/jobs` (`.`) | `./src/index.ts` | Data & Release | **Beta (Integration-Verified)** | `0.2.x` promotion candidate | Unified queue + scheduler barrel re-exporting queue and cron contracts without side effects on import. | [README](../packages/jobs/README.md) · [Queues](../apps/docs/content/techniques/queues.md) · [Task Scheduling](../apps/docs/content/techniques/task-scheduling.md) |
| `@bunest/jobs/queues` | `./src/queues/index.ts` | Data & Release | **Beta (Integration-Verified)** | `0.2.x` promotion candidate | `QueueModule` / `BullModule` / `BullMQModule`, `@Processor`, `WorkerHost`, `FlowProducer` with at-least-once delivery semantics, configurable retry backoff, and dead-letter queue (DLQ) routing on exhausted retries. | [README](../packages/jobs/README.md) · [Queues](../apps/docs/content/techniques/queues.md) |
| `@bunest/jobs/scheduler` | `./src/scheduler/index.ts` | Data & Release | **Beta (Integration-Verified)** | `0.2.x` promotion candidate | `ScheduleModule`, `@Cron`, `@Interval`, `@Timeout` with automatic timer cleanup on `onApplicationShutdown`. | [README](../packages/jobs/README.md) · [Task Scheduling](../apps/docs/content/techniques/task-scheduling.md) |
| `@bunest/jobs/redis` | `./src/redis/index.ts` | Data & Release | **Beta (Integration-Verified)** | `0.2.x` promotion candidate | Atomic Lua `RedisQueueDriver` (`Bun.RedisClient`) enforcing job leases and redelivery on lease expiry; production promotion requires real-Redis crash/lease-expiry/duplicate-delivery verification. | [README](../packages/jobs/README.md) · [Queues](../apps/docs/content/techniques/queues.md) *(dedicated Redis worker recovery runbook planned for `0.2.x`)* |
| `@bunest/jobs/package.json` | `./package.json` | Data & Release | **Beta (Integration-Verified)** | `0.2.x` promotion candidate | Exposes valid JSON package manifest metadata for runtime and CLI introspection. | [README](../packages/jobs/README.md) · [Public API Matrix](./public-api-matrix.md) |

#### `@bunest/security` (`0.1.0` — 7 exports)

| Export Subpath | Source Entry | Owner | Stability Tier | `1.0` Target | Guaranteed Behavior | Corresponding Docs |
| --- | --- | --- | --- | --- | --- | --- |
| `@bunest/security` (`.`) | `./src/index.ts` | Security & Ops | **Beta (Integration-Verified)** | `0.2.x` / `1.0` candidate | `SecurityModule.forRoot()`, `PasswordService` (`Bun.password` defaulting to `argon2id`), `SessionCookieService` (HMAC-SHA256 `HttpOnly` cookies), timing-safe `CsrfGuard`, and `SecurityHeadersMiddleware` with strict Helmet-style defaults. | [README](../packages/security/README.md) · [Security Guide](./security.md) · [Security Module](../apps/docs/content/security/security-module.md) |
| `@bunest/security/auth` | `./src/auth-next/index.ts` | Security & Ops | **Beta (Integration-Verified)** | `0.2.x` / `1.0` candidate | `AuthenticationModule` enforcing SHA-256-hashed opaque sessions with fixation & cross-origin write defense, single-use refresh-token families with reuse-triggered family revocation, AES-256-GCM-encrypted TOTP MFA with lockout/replay defense, and PKCE (`S256`) + `state`/`nonce`/RFC 9207 `iss` OIDC flows. | [README](../packages/security/README.md) · [Security Guide](./security.md) · [Authentication](../apps/docs/content/security/authentication.md) |
| `@bunest/security/authz` | `./src/authz/index.ts` | Security & Ops | **Beta (Integration-Verified)** | `0.2.x` / `1.0` candidate | Deny-by-default `@Policy()` / `@Can()` / `@Can.Anyone()` authorization (`AuthorizationGuard`, `AuthorizationService`) requiring literal `true` ability results and failing fast at startup if `AuthenticationGuard` is misordered. | [README](../packages/security/README.md) · [Security Guide](./security.md) · [Authorization](../apps/docs/content/security/authorization.md) |
| `@bunest/security/jwt` | `./src/jwt/index.ts` | Security & Ops | **Beta (Integration-Verified)** | `0.2.x` / `1.0` candidate | Native WebCrypto `JwtModule`, `JwtService`, and `JwksModule` enforcing constant-time verification, rejecting `alg: "none"`, blocking asymmetric/symmetric algorithm confusion, and mapping invalid/expired tokens to `401`. | [README](../packages/security/README.md) · [Security Guide](./security.md) |
| `@bunest/security/throttler` | `./src/throttler/index.ts` | Security & Ops | **Beta (Integration-Verified)** | `0.2.x` / `1.0` candidate | Sliding-window `ThrottlerModule` / `ThrottlerGuard` (`@Throttle`, `@SkipThrottle`) returning `429` without polluting the window on rejected hits and respecting `trustProxy` IP extraction. | [README](../packages/security/README.md) · [Security Guide](./security.md) |
| `@bunest/security/testing` | `./src/auth-next/testing/index.ts` | Security & Ops | **Beta (Integration-Verified)** | `0.2.x` / `1.0` candidate | In-memory authentication/session/MFA test fixtures and deterministic clock/token helpers for integration tests. | [README](../packages/security/README.md) · [Authentication](../apps/docs/content/security/authentication.md) *(dedicated testing subpath guide planned for `1.0`)* |
| `@bunest/security/package.json` | `./package.json` | Security & Ops | **Beta (Integration-Verified)** | `0.2.x` / `1.0` candidate | Exposes valid JSON package manifest metadata for runtime and CLI introspection. | [README](../packages/security/README.md) · [Public API Matrix](./public-api-matrix.md) |

#### `@bunest/swagger` (`0.1.0` — 2 exports)

| Export Subpath | Source Entry | Owner | Stability Tier | `1.0` Target | Guaranteed Behavior | Corresponding Docs |
| --- | --- | --- | --- | --- | --- | --- |
| `@bunest/swagger` (`.`) | `./src/index.ts` | Core & DX | **Beta (Integration-Verified)** | `0.2.x` / `1.0` candidate | Generates valid OpenAPI 3.1 documents from controller/DTO metadata (`DocumentBuilder`, `SwaggerModule`, `@Api*` decorators) and serves Swagger UI / Scalar without mutating application routes. | [README](../packages/swagger/README.md) · [OpenAPI](../apps/docs/content/apis/openapi.md) |
| `@bunest/swagger/package.json` | `./package.json` | Core & DX | **Beta (Integration-Verified)** | `0.2.x` / `1.0` candidate | Exposes valid JSON package manifest metadata for runtime and CLI introspection. | [README](../packages/swagger/README.md) · [Public API Matrix](./public-api-matrix.md) |

#### `@bunest/testing` (`0.1.0` — 2 exports)

| Export Subpath | Source Entry | Owner | Stability Tier | `1.0` Target | Guaranteed Behavior | Corresponding Docs |
| --- | --- | --- | --- | --- | --- | --- |
| `@bunest/testing` (`.`) | `./src/index.ts` | Core & DX | **Beta (Integration-Verified)** | `1.0 Stable Candidate` | `Test.createTestingModule()` with provider/guard/interceptor/pipe/filter overrides, `ModuleMocker`, ephemeral-port `request(app)` / `TestClient`, and `CapturingLogger` ensuring clean resource teardown on `app.close()`. | [README](../packages/testing/README.md) · [Testing Guide](./testing.md) · [Testing Docs](../apps/docs/content/fundamentals/testing.md) |
| `@bunest/testing/package.json` | `./package.json` | Core & DX | **Beta (Integration-Verified)** | `1.0 Stable Candidate` | Exposes valid JSON package manifest metadata for runtime and CLI introspection. | [README](../packages/testing/README.md) · [Public API Matrix](./public-api-matrix.md) |

#### `@bunest/cli` (`0.1.0` — 3 exports)

| Export Subpath | Source Entry | Owner | Stability Tier | `1.0` Target | Guaranteed Behavior | Corresponding Docs |
| --- | --- | --- | --- | --- | --- | --- |
| `@bunest/cli` (`.`) | `./src/index.ts` | Core & DX | **Beta (Integration-Verified)** | `1.0 Stable Candidate` | Programmatic CLI runner (`new`, `generate`, `build`, `verify`, `doctor`), schematics, and `bunestMetadataPlugin()` working identically both inside and outside the monorepo with deterministic exit codes. | [README](../packages/cli/README.md) · [CLI Docs](../apps/docs/content/observability/cli.md) · [Quickstart](./quickstart.md) |
| `@bunest/cli/analyzer` | `./src/analyzer/index.ts` | Core & DX | **Beta (Integration-Verified)** | `1.0 Stable Candidate` | Static project graph analyzer emitting stable `BUNEST*` diagnostics with file/line spans and actionable remediation hints. | [README](../packages/cli/README.md) · [CLI Docs](../apps/docs/content/observability/cli.md) · [Errors](./errors.md) |
| `@bunest/cli/package.json` | `./package.json` | Core & DX | **Beta (Integration-Verified)** | `1.0 Stable Candidate` | Exposes valid JSON package manifest metadata for runtime and CLI introspection. | [README](../packages/cli/README.md) · [Public API Matrix](./public-api-matrix.md) |

#### `@bunest/resilience` (`0.1.0` — 6 exports)

| Export Subpath | Source Entry | Owner | Stability Tier | `1.0` Target | Guaranteed Behavior | Corresponding Docs |
| --- | --- | --- | --- | --- | --- | --- |
| `@bunest/resilience` (`.`) | `./src/index.ts` | Security & Ops | **Beta (Integration-Verified)** | `0.2.x` / `1.0` candidate | Composable Promise-based fault-tolerance decorators (`@Retry`, `@Timeout`, `@CircuitBreaker`, `@Bulkhead`, `@RateLimit`, `@Fallback`) with bounded concurrency and deterministic state transitions. | [README](../packages/resilience/README.md) · [Resilience](../apps/docs/content/distributed/resilience.md) |
| `@bunest/resilience/locks` | `./src/locks/index.ts` | Security & Ops | **Beta (Integration-Verified)** | `0.2.x` / `1.0` candidate | Distributed leased locks with monotonic fencing tokens, lease renewal, `@WithLock()`, and `@OnOneInstance()` guaranteeing automatic release on handler completion or failure. | [README](../packages/resilience/README.md) · [Locks & Idempotency](../apps/docs/content/distributed/locks-idempotency.md) |
| `@bunest/resilience/locks/testing` | `./src/locks/testing/index.ts` | Security & Ops | **Beta (Integration-Verified)** | `0.2.x` / `1.0` candidate | Deterministic in-memory lock store test doubles supporting lease expiry and contention simulation. | [README](../packages/resilience/README.md) · [Locks & Idempotency](../apps/docs/content/distributed/locks-idempotency.md) *(dedicated testing subpath guide planned for `1.0`)* |
| `@bunest/resilience/idempotency` | `./src/idempotency/index.ts` | Security & Ops | **Beta (Integration-Verified)** | `0.2.x` / `1.0` candidate | `@Idempotent()` request deduplication returning cached responses for matching idempotency keys and rejecting concurrent/mismatched payload conflicts deterministically. | [README](../packages/resilience/README.md) · [Locks & Idempotency](../apps/docs/content/distributed/locks-idempotency.md) |
| `@bunest/resilience/idempotency/testing` | `./src/idempotency/testing/index.ts` | Security & Ops | **Beta (Integration-Verified)** | `0.2.x` / `1.0` candidate | In-memory idempotency store test doubles for unit and integration verification. | [README](../packages/resilience/README.md) · [Locks & Idempotency](../apps/docs/content/distributed/locks-idempotency.md) *(dedicated testing subpath guide planned for `1.0`)* |
| `@bunest/resilience/package.json` | `./package.json` | Security & Ops | **Beta (Integration-Verified)** | `0.2.x` / `1.0` candidate | Exposes valid JSON package manifest metadata for runtime and CLI introspection. | [README](../packages/resilience/README.md) · [Public API Matrix](./public-api-matrix.md) |

---

### 3.3 Preview / Experimental (8 Packages, 41 Exports)

#### `@bunest/ai` (`0.1.0` — 6 exports)

| Export Subpath | Source Entry | Owner | Stability Tier | `1.0` Target | Guaranteed Behavior | Corresponding Docs |
| --- | --- | --- | --- | --- | --- | --- |
| `@bunest/ai` (`.`) | `./src/index.ts` | Ecosystem | **Preview / Experimental** | `0.2.x+` evaluation | Native `fetch()` SSE clients (OpenAI, Anthropic, Gemini), `generateText`, `generateObject`, `streamText`, and `@AgentFunction` tool dispatch; experimental API surface subject to minor-cycle refinement. | [README](../packages/ai/README.md) · [AI SDK](../apps/docs/content/ai/ai-sdk.md) |
| `@bunest/ai/testing` | `./src/testing/index.ts` | Ecosystem | **Preview / Experimental** | `0.2.x+` evaluation | Deterministic mock LLM providers and scripted SSE streaming fixtures for offline testing. | [README](../packages/ai/README.md) · [AI SDK](../apps/docs/content/ai/ai-sdk.md) *(dedicated testing subpath guide planned for `0.2.x+`)* |
| `@bunest/ai/workflows` | `./src/workflows/index.ts` | Ecosystem | **Preview / Experimental** | `0.2.x+` evaluation | Durable agent workflow step adapters bridging `@bunest/ai` tool calls with `@bunest/workflows` replay. | [README](../packages/ai/README.md) · [AI SDK](../apps/docs/content/ai/ai-sdk.md) · [Workflows](../apps/docs/content/distributed/workflows.md) *(dedicated integration guide planned for `0.2.x+`)* |
| `@bunest/ai/mcp` | `./src/mcp/index.ts` | Ecosystem | **Preview / Experimental** | `0.2.x+` evaluation | Model Context Protocol server (`@Tool`, `@Resource`, `@ResourceTemplate`, `@Prompt`) over stdio and HTTP/SSE JSON-RPC. | [README](../packages/ai/README.md) · [MCP](../apps/docs/content/ai/mcp.md) |
| `@bunest/ai/mcp/testing` | `./src/mcp/testing/index.ts` | Ecosystem | **Preview / Experimental** | `0.2.x+` evaluation | In-process MCP JSON-RPC client/server test harness for verifying tool/resource handlers. | [README](../packages/ai/README.md) · [MCP](../apps/docs/content/ai/mcp.md) *(dedicated testing subpath guide planned for `0.2.x+`)* |
| `@bunest/ai/package.json` | `./package.json` | Ecosystem | **Preview / Experimental** | `0.2.x+` evaluation | Exposes valid JSON package manifest metadata for runtime and CLI introspection. | [README](../packages/ai/README.md) · [Public API Matrix](./public-api-matrix.md) |

#### `@bunest/elasticsearch` (`0.1.0` — 2 exports)

| Export Subpath | Source Entry | Owner | Stability Tier | `1.0` Target | Guaranteed Behavior | Corresponding Docs |
| --- | --- | --- | --- | --- | --- | --- |
| `@bunest/elasticsearch` (`.`) | `./src/index.ts` | Ecosystem | **Preview / Experimental** | `0.2.x+` evaluation | `ElasticsearchModule` and zero-dep `fetch()` REST client for index/search/bulk operations; awaiting real-cluster failover & soak verification. | [README](../packages/elasticsearch/README.md) · [Elasticsearch](../apps/docs/content/data/elasticsearch.md) |
| `@bunest/elasticsearch/package.json` | `./package.json` | Ecosystem | **Preview / Experimental** | `0.2.x+` evaluation | Exposes valid JSON package manifest metadata for runtime and CLI introspection. | [README](../packages/elasticsearch/README.md) · [Public API Matrix](./public-api-matrix.md) |

#### `@bunest/graphql` (`0.1.0` — 3 exports)

| Export Subpath | Source Entry | Owner | Stability Tier | `1.0` Target | Guaranteed Behavior | Corresponding Docs |
| --- | --- | --- | --- | --- | --- | --- |
| `@bunest/graphql` (`.`) | `./src/index.ts` | Ecosystem | **Preview / Experimental** | `0.2.x+` evaluation | Code-first & schema-first GraphQL execution, per-request `BunestDataLoader` batching, and PubSub + SSE/`graphql-ws` subscriptions; awaiting production soak verification. | [README](../packages/graphql/README.md) · [GraphQL](../apps/docs/content/apis/graphql.md) |
| `@bunest/graphql/apollo` | `./src/apollo/index.ts` | Ecosystem | **Preview / Experimental** | `0.2.x+` evaluation | `ApolloDriver` and Federation v2 Subgraph/Gateway driver adapters compatible with NestJS GraphQL decorators. | [README](../packages/graphql/README.md) · [GraphQL](../apps/docs/content/apis/graphql.md) *(dedicated Apollo/Federation guide planned for `0.2.x+`)* |
| `@bunest/graphql/package.json` | `./package.json` | Ecosystem | **Preview / Experimental** | `0.2.x+` evaluation | Exposes valid JSON package manifest metadata for runtime and CLI introspection. | [README](../packages/graphql/README.md) · [Public API Matrix](./public-api-matrix.md) |

#### `@bunest/mail` (`0.1.0` — 4 exports)

| Export Subpath | Source Entry | Owner | Stability Tier | `1.0` Target | Guaranteed Behavior | Corresponding Docs |
| --- | --- | --- | --- | --- | --- | --- |
| `@bunest/mail` (`.`) | `./src/index.ts` | Ecosystem | **Preview / Experimental** | `0.2.x+` evaluation | `MailModule`, typed mail classes, and zero-dep `fetch()` transports (Resend, Postmark, SendGrid, SES) with structured delivery results. | [README](../packages/mail/README.md) · [Mail](../apps/docs/content/techniques/mail.md) |
| `@bunest/mail/smtp` | `./src/smtp/index.ts` | Ecosystem | **Preview / Experimental** | `0.2.x+` evaluation | Native Bun socket SMTP transport supporting STARTTLS and AUTH; awaiting real-MTA fault/retry verification. | [README](../packages/mail/README.md) · [Mail](../apps/docs/content/techniques/mail.md) *(dedicated SMTP guide planned for `0.2.x+`)* |
| `@bunest/mail/templates` | `./src/templates/index.ts` | Ecosystem | **Preview / Experimental** | `0.2.x+` evaluation | Auto-escaped `Bun.escapeHTML` mail template helpers preventing raw HTML injection by default. | [README](../packages/mail/README.md) · [Mail](../apps/docs/content/techniques/mail.md) *(dedicated template guide planned for `0.2.x+`)* |
| `@bunest/mail/package.json` | `./package.json` | Ecosystem | **Preview / Experimental** | `0.2.x+` evaluation | Exposes valid JSON package manifest metadata for runtime and CLI introspection. | [README](../packages/mail/README.md) · [Public API Matrix](./public-api-matrix.md) |

#### `@bunest/messaging` (`0.1.0` — 12 exports)

| Export Subpath | Source Entry | Owner | Stability Tier | `1.0` Target | Guaranteed Behavior | Corresponding Docs |
| --- | --- | --- | --- | --- | --- | --- |
| `@bunest/messaging` (`.`) | `./src/index.ts` | Ecosystem | **Preview / Experimental** | `0.2.x+` evaluation | Unified messaging barrel re-exporting events, CQRS, outbox, and webhook primitives. | [README](../packages/messaging/README.md) · [Events](../apps/docs/content/techniques/events.md) · [CQRS](../apps/docs/content/distributed/cqrs.md) · [Outbox & Webhooks](../apps/docs/content/distributed/outbox-webhooks.md) |
| `@bunest/messaging/events` | `./src/events/index.ts` | Ecosystem | **Preview / Experimental** | `0.2.x+` evaluation | In-process `EventEmitterModule` / `@OnEvent()` supporting sync/async listeners and wildcard patterns. | [README](../packages/messaging/README.md) · [Events](../apps/docs/content/techniques/events.md) |
| `@bunest/messaging/cqrs` | `./src/cqrs/index.ts` | Ecosystem | **Preview / Experimental** | `0.2.x+` evaluation | `CqrsModule`, `CommandBus`, `QueryBus`, `EventBus`, and Promise-based Sagas (no RxJS). | [README](../packages/messaging/README.md) · [CQRS](../apps/docs/content/distributed/cqrs.md) |
| `@bunest/messaging/outbox` | `./src/outbox/index.ts` | Ecosystem | **Preview / Experimental** | `0.2.x+` evaluation | Transactional Outbox publisher & Consumer Inbox deduplication contracts with at-least-once relay semantics. | [README](../packages/messaging/README.md) · [Outbox & Webhooks](../apps/docs/content/distributed/outbox-webhooks.md) |
| `@bunest/messaging/outbox/testing` | `./src/outbox/testing/index.ts` | Ecosystem | **Preview / Experimental** | `0.2.x+` evaluation | In-memory Outbox/Inbox store test doubles for deterministic relay & deduplication unit tests. | [README](../packages/messaging/README.md) · [Outbox & Webhooks](../apps/docs/content/distributed/outbox-webhooks.md) *(dedicated testing subpath guide planned for `0.2.x+`)* |
| `@bunest/messaging/outbox/postgres` | `./src/outbox/postgres/index.ts` | Ecosystem | **Preview / Experimental** | `0.2.x+` evaluation | PostgreSQL Outbox/Inbox store using `SKIP LOCKED` batch claiming; awaiting real-PG crash/soak verification. | [README](../packages/messaging/README.md) · [Outbox & Webhooks](../apps/docs/content/distributed/outbox-webhooks.md) *(dedicated PG ops guide planned for `0.2.x+`)* |
| `@bunest/messaging/outbox/mysql` | `./src/outbox/mysql/index.ts` | Ecosystem | **Preview / Experimental** | `0.2.x+` evaluation | MySQL Outbox/Inbox store implementation; awaiting real-MySQL verification. | [README](../packages/messaging/README.md) · [Outbox & Webhooks](../apps/docs/content/distributed/outbox-webhooks.md) *(dedicated MySQL guide planned for `0.2.x+`)* |
| `@bunest/messaging/webhooks` | `./src/webhooks/index.ts` | Ecosystem | **Preview / Experimental** | `0.2.x+` evaluation | Outbound/inbound webhooks with HMAC-SHA256 signing/verification, SSRF `AddressPolicy` IP filtering, and AES-256-GCM secret sealing. | [README](../packages/messaging/README.md) · [Outbox & Webhooks](../apps/docs/content/distributed/outbox-webhooks.md) |
| `@bunest/messaging/webhooks/testing` | `./src/webhooks/testing/index.ts` | Ecosystem | **Preview / Experimental** | `0.2.x+` evaluation | In-memory webhook delivery store and signer test doubles. | [README](../packages/messaging/README.md) · [Outbox & Webhooks](../apps/docs/content/distributed/outbox-webhooks.md) *(dedicated testing subpath guide planned for `0.2.x+`)* |
| `@bunest/messaging/webhooks/postgres` | `./src/webhooks/postgres/index.ts` | Ecosystem | **Preview / Experimental** | `0.2.x+` evaluation | PostgreSQL webhook subscription & delivery ledger store; awaiting real-PG soak verification. | [README](../packages/messaging/README.md) · [Outbox & Webhooks](../apps/docs/content/distributed/outbox-webhooks.md) *(dedicated PG ops guide planned for `0.2.x+`)* |
| `@bunest/messaging/webhooks/mysql` | `./src/webhooks/mysql/index.ts` | Ecosystem | **Preview / Experimental** | `0.2.x+` evaluation | MySQL webhook subscription & delivery ledger store; awaiting real-MySQL verification. | [README](../packages/messaging/README.md) · [Outbox & Webhooks](../apps/docs/content/distributed/outbox-webhooks.md) *(dedicated MySQL guide planned for `0.2.x+`)* |
| `@bunest/messaging/package.json` | `./package.json` | Ecosystem | **Preview / Experimental** | `0.2.x+` evaluation | Exposes valid JSON package manifest metadata for runtime and CLI introspection. | [README](../packages/messaging/README.md) · [Public API Matrix](./public-api-matrix.md) |

#### `@bunest/microservices` (`0.1.0` — 2 exports)

| Export Subpath | Source Entry | Owner | Stability Tier | `1.0` Target | Guaranteed Behavior | Corresponding Docs |
| --- | --- | --- | --- | --- | --- | --- |
| `@bunest/microservices` (`.`) | `./src/index.ts` | Ecosystem | **Preview / Experimental** | `0.2.x+` evaluation | `@MessagePattern`, `@EventPattern`, `@GrpcMethod`, `ClientProxy`, and pluggable transports (TCP, InMemory, Redis, NATS, RabbitMQ, Kafka, MQTT, gRPC); awaiting real-broker fault-injection verification per transport. | [README](../packages/microservices/README.md) · [Microservices](../apps/docs/content/distributed/microservices.md) |
| `@bunest/microservices/package.json` | `./package.json` | Ecosystem | **Preview / Experimental** | `0.2.x+` evaluation | Exposes valid JSON package manifest metadata for runtime and CLI introspection. | [README](../packages/microservices/README.md) · [Public API Matrix](./public-api-matrix.md) |

#### `@bunest/storage` (`0.1.0` — 5 exports)

| Export Subpath | Source Entry | Owner | Stability Tier | `1.0` Target | Guaranteed Behavior | Corresponding Docs |
| --- | --- | --- | --- | --- | --- | --- |
| `@bunest/storage` (`.`) | `./src/index.ts` | Ecosystem | **Preview / Experimental** | `0.2.x+` evaluation | `StorageModule`, unified disk interface (`put`/`get`/`delete`/`stat`/signed URLs), and `assertSafeStorageKey()` path-traversal & NTFS ADS rejection. | [README](../packages/storage/README.md) · [Storage](../apps/docs/content/techniques/storage.md) · [Security Guide](./security.md) |
| `@bunest/storage/s3` | `./src/s3/index.ts` | Ecosystem | **Preview / Experimental** | `0.2.x+` evaluation | Native `BunS3Disk` (`Bun.S3Client`) and SigV4 `S3Disk` (S3/R2/MinIO); awaiting real-S3 outage/multipart soak verification. | [README](../packages/storage/README.md) · [Storage](../apps/docs/content/techniques/storage.md) *(dedicated S3 ops guide planned for `0.2.x+`)* |
| `@bunest/storage/local` | `./src/local/index.ts` | Ecosystem | **Preview / Experimental** | `0.2.x+` evaluation | `LocalDisk` (`Bun.file().slice().stream()`) enforcing two-layer root containment via `assertSafeStorageKey()`. | [README](../packages/storage/README.md) · [Storage](../apps/docs/content/techniques/storage.md) · [Security Guide](./security.md) |
| `@bunest/storage/memory` | `./src/memory/index.ts` | Ecosystem | **Preview / Experimental** | `0.2.x+` evaluation | `InMemoryDisk` implementing the full disk contract for ephemeral storage and unit tests. | [README](../packages/storage/README.md) · [Storage](../apps/docs/content/techniques/storage.md) *(dedicated testing subpath guide planned for `0.2.x+`)* |
| `@bunest/storage/package.json` | `./package.json` | Ecosystem | **Preview / Experimental** | `0.2.x+` evaluation | Exposes valid JSON package manifest metadata for runtime and CLI introspection. | [README](../packages/storage/README.md) · [Public API Matrix](./public-api-matrix.md) |

#### `@bunest/workflows` (`0.1.0` — 7 exports)

| Export Subpath | Source Entry | Owner | Stability Tier | `1.0` Target | Guaranteed Behavior | Corresponding Docs |
| --- | --- | --- | --- | --- | --- | --- |
| `@bunest/workflows` (`.`) | `./src/index.ts` | Ecosystem | **Preview / Experimental** | `0.2.x+` evaluation | Durable `WorkflowsModule` with deterministic replay, signals, timers, sagas, and schedules; awaiting real-DB worker-crash soak verification. | [README](../packages/workflows/README.md) · [Workflows](../apps/docs/content/distributed/workflows.md) |
| `@bunest/workflows/core` | `./src/core/index.ts` | Ecosystem | **Preview / Experimental** | `0.2.x+` evaluation | Framework-agnostic durable workflow runtime primitives and replay engine without DI coupling. | [README](../packages/workflows/README.md) · [Workflows](../apps/docs/content/distributed/workflows.md) *(dedicated core runtime guide planned for `0.2.x+`)* |
| `@bunest/workflows/cqrs` | `./src/cqrs/index.ts` | Ecosystem | **Preview / Experimental** | `0.2.x+` evaluation | CQRS bridge dispatching workflow commands and events through `@bunest/messaging/cqrs`. | [README](../packages/workflows/README.md) · [Workflows](../apps/docs/content/distributed/workflows.md) · [CQRS](../apps/docs/content/distributed/cqrs.md) *(dedicated integration guide planned for `0.2.x+`)* |
| `@bunest/workflows/postgres` | `./src/postgres/index.ts` | Ecosystem | **Preview / Experimental** | `0.2.x+` evaluation | PostgreSQL durable workflow state & event-history store; awaiting real-PG crash/replay verification. | [README](../packages/workflows/README.md) · [Workflows](../apps/docs/content/distributed/workflows.md) *(dedicated PG ops guide planned for `0.2.x+`)* |
| `@bunest/workflows/mysql` | `./src/mysql/index.ts` | Ecosystem | **Preview / Experimental** | `0.2.x+` evaluation | MySQL durable workflow state & event-history store; awaiting real-MySQL verification. | [README](../packages/workflows/README.md) · [Workflows](../apps/docs/content/distributed/workflows.md) *(dedicated MySQL guide planned for `0.2.x+`)* |
| `@bunest/workflows/testing` | `./src/testing/index.ts` | Ecosystem | **Preview / Experimental** | `0.2.x+` evaluation | Deterministic workflow test harness with virtual clock advancement for timers and replay assertions. | [README](../packages/workflows/README.md) · [Workflows](../apps/docs/content/distributed/workflows.md) *(dedicated testing subpath guide planned for `0.2.x+`)* |
| `@bunest/workflows/package.json` | `./package.json` | Ecosystem | **Preview / Experimental** | `0.2.x+` evaluation | Exposes valid JSON package manifest metadata for runtime and CLI introspection. | [README](../packages/workflows/README.md) · [Public API Matrix](./public-api-matrix.md) |

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
   - In **`0.1.x` → `0.2.x`**: Production Preview exports receive at least one patch/minor notice and a written migration path before removal or signature change; any core contract change requires an ADR in [`docs/adr/`](./adr/README.md).
   - In **`1.0.0+`**: Deprecated Stable exports remain functional for **at least one minor release** (or **6 months** on LTS lines) before removal in the next major release (`2.0.0+`).
4. **Upgrade Verification**: Every release candidate in `0.1.x`, `0.2.x`, and `1.0.0-rc` is verified by upgrading an out-of-monorepo pilot application across **two consecutive versions** using real published artifacts (see [`docs/support-policy.md`](./support-policy.md#5-2-consecutive-version-upgrade-verification-policy) and [`docs/production-preview.md`](./production-preview.md)).

### 4.3 Module Promotion Gate (`Preview` → `Beta` → `Production Preview` / `1.0 Stable`)

No package or subpath is promoted based on unit or NestJS conformance test counts alone:

- **`Preview / Experimental` → `Beta`**: 100% unit/conformance coverage + automated real-service integration tests in CI + documented public subpath contract.
- **`Beta` → `Production Preview` / `1.0 Stable`**: Dedicated real-infrastructure fault-injection and soak verification, operational runbook (including failure/redelivery semantics), out-of-monorepo clean-install & 2-consecutive-version upgrade proof, and a designated module maintainer.

---

## 5. Week 14 Contract-Diff & Deprecation Review Template

Use this template during **Week 14** (and before every minor or `1.0` RC freeze) to compare public exports, runtime behavior, and user-facing migration impact between the previous published release and the candidate (`docs/ke-hoach-phat-trien-bunest.md` §9 Week 14). Prioritize any point where an existing application must make manual code or config changes.

```markdown
# Contract-Diff & Deprecation Review — `<from-version>` → `<to-version>`

| Field | Value |
| --- | --- |
| **Baseline Published Version & Source** | `<e.g. 0.1.x from npm / staging registry URL + commit SHA>` |
| **Candidate Version & Commit SHA** | `<e.g. 0.2.0-rc.1 / 1.0.0-rc.1 — full 40-char SHA>` |
| **Reviewers** | Core & DX (Person A): `<name>` · Data & Release (Person B): `<name>` |
| **Exports Count Check** | `19 packages` · `<N> declared package.json#exports keys` (diff attached) |

### 1. Public `package.json#exports` & `.d.ts` Surface Diff

| Package & Subpath | Symbol / Contract | Change Type (`Added` / `Changed` / `Deprecated` / `Removed`) | Manual User Edit Required? (`YES` / `NO`) | Decision (`Keep Compat` / `Deprecate` / `Breaking + Migration`) | ADR / Migration Link | Owner |
| --- | --- | --- | --- | --- | --- | --- |
| `<@bunest/pkg/subpath>` | `<symbol or behavior>` | `<type>` | `<YES/NO>` | `<decision>` | `<docs/adr/ADR-XXX.md or CHANGELOG.md>` | `<owner>` |

### 2. Behavioral Contract Checks (Non-Type-Level Diffs)

- [ ] **DI & Lifecycle:** Module export visibility, request-scope propagation, and `onModuleInit` / `onApplicationShutdown` ordering unchanged (or documented).
- [ ] **HTTP Pipeline & Errors:** 11-stage pipeline order, `bodyLimit` `413`, malformed body `400`, `DefaultExceptionFilter` production redaction, and `BUNEST_E*` codes unchanged.
- [ ] **Validation & Serialization:** `ValidationPipe` strict defaults (`ADR-009`) and error response shape unchanged.
- [ ] **ORM / Migrations:** Existing PostgreSQL migrations and expand-and-contract rollback compatibility preserved.
- [ ] **Observability & Security:** `/live`, `/ready` (`200 → 503 → 200`), log redaction keys, and `/_devtools/*` production gate unchanged.

### 3. Deprecation Registry Updates

| Package & Subpath | Deprecated Symbol | Replacement | Diagnostic (`BUNEST*` / Warning) | Announced In | Earliest Removal Version |
| --- | --- | --- | --- | --- | --- |
| `<@bunest/pkg/subpath>` | `<oldSymbol>` | `<newSymbol>` | `<code or warning>` | `<X.Y.Z>` | `<next minor / 2.0.0>` |

### 4. Sign-Off

- [ ] Every `Manual User Edit Required = YES` item has either been reverted to keep compatibility or has an approved ADR, `CHANGELOG.md` migration note, and tested upgrade path.
- [ ] `docs/public-api-matrix.md` and `docs/support-policy.md` reflect the exact candidate exports and stability tiers.
```

---

## 6. `1.0` API Freeze & RC Go / No-Go Checklist

No `1.0.0-rc.*` build may be promoted to **`1.0.0` General Availability** until **every** gate below is verified and signed off (aligned with [`docs/security.md`](./security.md#independent-security-review-scope-10-rc), [`docs/support-policy.md`](./support-policy.md), and [`docs/release-ops-templates.md`](./release-ops-templates.md)).

### 6.1 Frozen Public API Surface (`package.json#exports`)

- [ ] All 19 `@bunest/*` `package.json#exports` maps are frozen for the `1.0.0` release commit (zero unreviewed additions, removals, or subpath renames after RC freeze).
- [ ] Every `1.0 Stable` export in Section 3 has an assigned **Owner**, concrete **Guaranteed Behavior**, verified **Corresponding Docs** (no broken links), and automated contract tests.
- [ ] All remaining **Preview / Experimental** packages and subpaths are explicitly labeled as non-GA in `docs/public-api-matrix.md`, `docs/support-policy.md`, and `CHANGELOG.md`.
- [ ] Week 14 Contract-Diff & Deprecation Review is complete with zero unresolved breaking changes lacking an ADR and migration guide.
- [ ] All monorepo release gates pass on the exact tagged commit on pinned **Linux + Bun `>= 1.4.5`**: `bun install --frozen-lockfile`, `bun run typecheck`, `bun run build`, `bun test`, `bun run conformance:gate` (0 fail, 0 skip), `bun run ai:docs --check`, and `bun run verify:release` (`0` external runtime deps, DAG intact).

### 6.2 Independent Security Audit Gate ([`docs/security.md`](./security.md#independent-security-review-scope-10-rc) & [`SECURITY.md`](../SECURITY.md))

- [ ] Independent third-party security review completed across all in-scope GA packages and all five trust boundaries on Linux + Bun `>= 1.4.5`.
- [ ] **Zero open Critical or High findings** remain across any in-scope package or subpath.
- [ ] Every remediated Critical/High finding has a committed regression test and a signed-off independent re-test verification against the patched RC build.
- [ ] Every open Medium/Low finding has documented mitigation guidance, explicit risk acceptance, or a scheduled post-GA patch milestone.
- [ ] Private advisory workflow and coordinated disclosure plan are ready per [`SECURITY.md`](../SECURITY.md#10-rc-private-finding-triage--re-verification-workflow).

### 6.3 2-Consecutive-Version Pilot Upgrade & Operational Proof ([`docs/support-policy.md`](./support-policy.md#5-2-consecutive-version-upgrade-verification-policy))

- [ ] Out-of-monorepo clean install from the target/staging registry succeeds for all 19 lockstep-versioned packages.
- [ ] **2-consecutive-version upgrade verification** passed on both Pilot A (greenfield) and Pilot B (NestJS migration) using **real published artifacts** for the baseline version and candidate artifacts for the target version, with provenance (registry URL, version, commit SHA, Bun version), compile/runtime logs, data/migration checks, and manual intervention time recorded.
- [ ] Real PostgreSQL smoke suite (`bun run smoke:postgres`), 2h steady-state soak (`p95 < 200 ms`, `5xx < 0.1%`, stable RSS), and `< 5 min` rolling rollback rehearsal passed on the RC build.

### 6.4 SemVer Maintainer Sign-Off

| Role | Maintainer | Commitment Verified | Commit SHA | Date | Sign-Off |
| --- | --- | --- | --- | --- | --- |
| **Core & DX (Person A)** | `<name>` | Frozen `package.json#exports`, `.d.ts` contract, docs/migration parity, SemVer `1.x` compatibility commitment | `<40-char SHA>` | `<YYYY-MM-DD>` | `[ ] APPROVED` |
| **Data & Release (Person B)** | `<name>` | Pinned Linux CI, registry clean install, 2-consecutive-version real-artifact upgrades, soak & rollback proof, npm `--provenance` publish | `<40-char SHA>` | `<YYYY-MM-DD>` | `[ ] APPROVED` |
| **Security & Ops Lead** | `<name>` | Zero open Critical/High audit findings, verified re-tests, `SECURITY.md` SLA & backport readiness | `<40-char SHA>` | `<YYYY-MM-DD>` | `[ ] APPROVED` |
