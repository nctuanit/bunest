# Implementation Roadmap

Bunest follows a phased, gate-driven roadmap prioritizing **correctness, strict architectural contracts, zero circular imports, and reproducible benchmarks**.

## Release Milestones

| Version | Target Scope | Status |
|---|---|---|
| **`v0.1`** | Foundation: Legacy decorators, metadata registry, strict DI & `@Module()` graph, lifecycle, native `Bun.serve` HTTP adapter, core packages | **Completed** |
| **`v0.2`** | NestJS v12 Parity: `DiscoveryService`/`MetadataScanner`, API Versioning, `RouterModule`, `ConfigurableModuleBuilder`, Durable DI, `LazyModuleLoader`, `ClsModule`, `rawBody`, `StreamableFile`, `ParseFilePipe`, `CompressionMiddleware`, `useStaticAssets`, Standard Schema v1, `@bunest/mapped-types` | **Completed** |
| **`v0.5`** | Complete 53-Package Official Ecosystem: Tier-1 & Tier-2 packages (`@bunest/ai`, `@bunest/mcp`, `@bunest/observe`, `@bunest/http-client`, `@bunest/axios`, `@bunest/i18n`, `@bunest/mail`, `@bunest/storage`, `@bunest/authentication`, `@bunest/authorization`, `@bunest/resilience`, `@bunest/locks`, `@bunest/idempotency`, `@bunest/store-kit`, `@bunest/outbox`, `@bunest/webhooks`, `@bunest/workflows`, ORM/ODM/Search/Apollo/Bull adapters, and 8 drop-in `@nestjs/*` facades) | **Completed** |
| **`v0.8`** | Service-Layer AOP & Spring Data-Style Declarative Repositories ([ADR-014](/architecture/adrs)): zero-overhead `MethodAspectWeaver`, `@Transactional`, compiled-once `@SqliteRepository`/`@SqlRepository` + `JpaRepository`/`SqlCrudRepository`, `@UseMiddleware`, `@Cacheable`, `@Span`, `@EmitEvent`, `@Auth`/`@Protected`, `@InjectConfig`, `@WithLock`, `@WithCls`, service-level `@Retry`/`@CircuitBreaker` | **Completed** |
| **`v1.0`** | Frozen core contracts, semver policy, external security audit, production battle-testing | **In Progress** |

## Phased Breakdown

### Phase 0 — Foundation *(Complete)*
- [x] Architecture Decision Records (`ADR-001` – `ADR-014`) & `RFC-001` locked
- [x] `@bunest/common`, `@bunest/core`, `@bunest/validation`, `@bunest/mapped-types` with 100% ADR-adjusted NestJS v12.5.1 parity

### Phase 1 — HTTP Core & NestJS v12 Parity *(Complete)*
- [x] `@bunest/http`: Bun-native `AbstractHttpAdapter` & `BunHttpAdapter`, hybrid `Bun.serve({ routes })` + `FallbackRadixRouter`, Fetch-Metadata CSRF, Helmet-8 security headers, HMAC-SHA256 signed cookies, `@Render()`, API Versioning, `CompressionMiddleware`, `useStaticAssets`, `@UseMiddleware`

### Phase 2 — Developer Experience *(Complete)*
- [x] `@bunest/testing`, `@bunest/config`, `@bunest/cli`, `@bunest/swagger`, `@bunest/http-client`, `@bunest/axios`, `@bunest/i18n`, `@bunest/mail`, `@bunest/storage`, `@bunest/serve-static`

### Phase 3 — Security, Identity & Data Persistence *(Complete)*
- [x] `@bunest/security`, `@bunest/jwt`, `@bunest/passport`, `@bunest/throttler`, `@bunest/authentication`, `@bunest/authorization`
- [x] `@bunest/sqlite`, `@bunest/sql`, `@bunest/prisma`, `@bunest/drizzle`, `@bunest/typeorm`, `@bunest/mongoose`, `@bunest/sequelize`, `@bunest/elasticsearch`, `@bunest/store-kit`

### Phase 4 — Realtime, Distributed Systems, AI & Observability *(Complete)*
- [x] `@bunest/websockets`, `@bunest/graphql`, `@bunest/apollo`
- [x] `@bunest/events`, `@bunest/scheduler`, `@bunest/cache`, `@bunest/queues`, `@bunest/bull`, `@bunest/bullmq`, `@bunest/cqrs`, `@bunest/microservices`
- [x] `@bunest/resilience`, `@bunest/locks`, `@bunest/idempotency`, `@bunest/outbox`, `@bunest/webhooks`, `@bunest/workflows`
- [x] `@bunest/ai`, `@bunest/mcp`
- [x] `@bunest/observability`, `@bunest/terminus`, `@bunest/devtools-integration`, `@bunest/observe`

### Phase 5 — Service-Layer AOP & Declarative Repositories *(Complete)*
- [x] Zero-overhead `DIContainer` `MethodAspectWeaver` (`O(1)` `WeakMap` skip for undecorated classes)
- [x] Compiled-once declarative repositories (`@SqliteRepository`/`JpaRepository` and `@SqlRepository`/`SqlCrudRepository`) with derived finders and `@Query`/`@Modifying`/`@SqlParam`
- [x] Public reproducible 8-target head-to-head benchmark suite comparing Bunest vs raw `Bun.serve()` vs NestJS v12 on Bun & Node.js

## Benchmark Integrity Policy

Bunest never publishes unverified *"X times faster"* marketing claims. Every benchmark published for Bunest must disclose:

1. Exact Bun version, OS, CPU, RAM, and package versions.
2. Route count, payload size, concurrency, keep-alive, warmup, and duration.
3. Equivalent middleware/validation/logging configurations across frameworks.
4. Throughput (req/s), latency `p50`/`p95`/`p99`, CPU, memory/RSS, and error rate—with reproducible scripts committed in the repository.
