# Implementation Roadmap

Bunest follows a phased, gate-driven roadmap prioritizing **correctness, strict architectural contracts, zero circular imports, and reproducible benchmarks**.

## Release Milestones

| Version    | Target Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Status          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| **`v0.1`** | Foundation: Legacy decorators, metadata registry, strict DI & `@Module()` graph, lifecycle, native `Bun.serve` HTTP adapter, core packages                                                                                                                                                                                                                                                                                                                                            | **Completed**   |
| **`v0.2`** | NestJS v12 Parity: `DiscoveryService`/`MetadataScanner`, API Versioning, `RouterModule`, `ConfigurableModuleBuilder`, Durable DI, `LazyModuleLoader`, `ClsModule`, `rawBody`, `StreamableFile`, `ParseFilePipe`, `CompressionMiddleware`, `useStaticAssets`, Standard Schema v1, mapped DTO types | **Completed**   |
| **`v0.5`** | Unified Bun-Native NestJS v12 Ecosystem: 35 consolidated packages (`@bunest/orm`, `@bunest/ai`, `@bunest/ai/mcp`, `@bunest/core/client`, `@bunest/core/i18n`, `@bunest/mail`, `@bunest/storage`, `@bunest/security/auth`, `@bunest/security/authz`, `@bunest/resilience`, `@bunest/resilience/locks`, `@bunest/resilience/idempotency`, `@bunest/messaging/outbox`, `@bunest/messaging/webhooks`, `@bunest/workflows`, `@bunest/elasticsearch`, `@bunest/graphql/apollo`, plus unified `@bunest/jobs/queues`, `@bunest/security`, `@bunest/observability`, `@bunest/core/http`, `@bunest/validation`) | **Completed**   |
| **`v0.8`** | Service-Layer AOP & Unified Bun-Native `@bunest/orm` Declarative Repositories: zero-overhead `MethodAspectWeaver`, `@Transactional`, compiled-once `@Repository` + `CrudRepository`, `OrmMigrationRunner`, SQL Store Kit subpaths (`./store`, `./postgres`, `./mysql`, `./testing`), `@UseMiddleware`, `@Cacheable`, `@Span`, `@EmitEvent`, `@Auth`/`@Protected`, `@InjectConfig`, `@WithLock`, `@WithCls`, service-level `@Retry`/`@CircuitBreaker` | **Completed**   |
| **`v1.0`** | Frozen core contracts, semver policy, external security audit, production battle-testing                                                                                                                                                                                                                                                                                                                                                                                              | **In Progress** |

## Phased Breakdown

### Phase 0 — Foundation _(Complete)_

- [x] Architecture Decision Records (`ADR-001` – `ADR-014`) & `RFC-001` locked
- [x] `@bunest/core`, `@bunest/core`, `@bunest/validation` (including mapped DTO helpers) with 100% ADR-adjusted NestJS v12.5.1 parity

### Phase 1 — HTTP Core & NestJS v12 Parity _(Complete)_

- [x] `@bunest/core/http`: Bun-native `AbstractHttpAdapter` & `BunHttpAdapter`, hybrid `Bun.serve({ routes })` + `FallbackRadixRouter`, `ServeStaticModule`, Fetch-Metadata CSRF, Helmet-8 security headers, HMAC-SHA256 signed cookies, `@Render()`, API Versioning, `CompressionMiddleware`, `useStaticAssets`, `@UseMiddleware`

### Phase 2 — Developer Experience _(Complete)_

- [x] `@bunest/testing`, `@bunest/core/config`, `@bunest/cli`, `@bunest/swagger`, `@bunest/core/client`, `@bunest/core/i18n`, `@bunest/mail`, `@bunest/storage`

### Phase 3 — Security, Identity & Data Persistence _(Complete)_

- [x] `@bunest/security` (`JwtModule`, `PassportModule`, `ThrottlerModule`), `@bunest/security/auth`, `@bunest/security/authz`
- [x] `@bunest/orm` (12 dialects over `bun:sqlite`, `Bun.SQL`, `fetch()`, and `Bun.connect()`, plus `./store`, `./postgres`, `./mysql`, `./testing` subpaths), `@bunest/elasticsearch`

### Phase 4 — Realtime, Distributed Systems, AI & Observability _(Complete)_

- [x] `@bunest/core/ws`, `@bunest/graphql`, `@bunest/graphql/apollo`
- [x] `@bunest/messaging/events`, `@bunest/jobs/scheduler`, `@bunest/cache`, `@bunest/jobs/queues` (`QueueModule`, `BullModule`/`BullMQModule`), `@bunest/messaging/cqrs`, `@bunest/microservices`
- [x] `@bunest/resilience`, `@bunest/resilience/locks`, `@bunest/resilience/idempotency`, `@bunest/messaging/outbox`, `@bunest/messaging/webhooks`, `@bunest/workflows`
- [x] `@bunest/ai`, `@bunest/ai/mcp`
- [x] `@bunest/observability` (`ObservabilityModule`, `TerminusModule`/`HealthModule`, `DevtoolsModule`)

### Phase 5 — Service-Layer AOP & Declarative Repositories _(Complete)_

- [x] Zero-overhead `DIContainer` `MethodAspectWeaver` (`O(1)` `WeakMap` skip for undecorated classes)
- [x] Compiled-once declarative repositories in `@bunest/orm` (`@Repository`/`CrudRepository`) with derived finders, `@Query`/`@Modifying`/`@SqlParam`, `@Transactional`, and `OrmMigrationRunner`
- [x] Public reproducible 8-target head-to-head benchmark suite comparing Bunest vs raw `Bun.serve()` vs NestJS v12 on Bun & Node.js

## Benchmark Integrity Policy

Bunest never publishes unverified _"X times faster"_ marketing claims. Every benchmark published for Bunest must disclose:

1. Exact Bun version, OS, CPU, RAM, and package versions.
2. Route count, payload size, concurrency, keep-alive, warmup, and duration.
3. Equivalent middleware/validation/logging configurations across frameworks.
4. Throughput (req/s), latency `p50`/`p95`/`p99`, CPU, memory/RSS, and error rate—with reproducible scripts committed in the repository.
