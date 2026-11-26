# Implementation Roadmap & Support Scope

Bunest follows a phased, gate-driven roadmap prioritizing **correctness, strict architectural contracts, zero circular imports, zero external runtime dependencies, and reproducible benchmarks**.

> info **How to read this page** This roadmap separates four distinct dimensions: **(1) Current Released Version**, **(2) Production Support Scope** (declared per module from real-infrastructure tests, never inferred from unit/conformance counts alone), **(3) Implemented Monorepo Capabilities**, and **(4) Historical Pre-Consolidation Milestones**.

---

## 1. Current Release Status (`0.1.0 Production Preview`)

| Dimension | Current Status |
| --- | --- |
| **Released Version** | **`0.1.0` — Production Preview** (lockstep across all **19 `@bunest/*` packages**) |
| **Runtime Target** | **Bun `>= 1.4.5`** (pinned CI gate on Linux + Bun `1.4.5`; `latest` tracked on Linux, macOS, Windows) |
| **Package Architecture** | **19 consolidated packages** across 6 domains (`ADR-016`), **19/19 (100%) zero external runtime dependencies** (`ADR-017`), **0 RxJS**, **0 circular imports** |
| **NestJS v12 Conformance** | **7,005 / 7,005 (100.00%, 0 skip)** upstream conformance tests passing in the monorepo |
| **Production Preview Scope** | Linux + Bun `1.4.5` REST APIs with `@bunest/core`, `@bunest/validation`, `@bunest/orm` (PostgreSQL via `Bun.SQL`, explicit migrations), and `@bunest/observability` |

---

## 2. Release Path (`0.1.0` → `1.0`)

| Release Line | Scope & Commitment | Status |
| --- | --- | --- |
| **`0.1.0` (Production Preview)** | First public release of the consolidated 19-package zero-dependency ecosystem targeting Bun `>= 1.4.5`, reference PostgreSQL production app (`examples/production-rest-postgres`), runbooks, and release automation | **Released** |
| **`0.1.x` (Preview Hardening)** | Clean out-of-monorepo registry install & upgrade verification, real PostgreSQL persistence/migration/outage/backup smoke, 2-hour soak & `< 5 min` rollback rehearsal, pilot user validation, backward-compatible patches only | **In Progress** |
| **`0.2.x+` (Minor Cycles)** | Demand-driven promotion of additional modules (e.g., Redis-backed `@bunest/cache` / `@bunest/jobs` after real-infrastructure fault-injection tests), public `package.json#exports` audit, and deprecation policy | **Planned** |
| **`1.0.0` (General Availability)** | Frozen core contracts, full SemVer backward-compatibility commitment on public exports, independent security audit, and multi-version upgrade proof from pilot apps | **Planned** |

---

## 3. Production Support Scope (Per-Module Stability Tiers)

All 19 packages ship in lockstep under `0.1.x` with full unit and conformance test coverage, but **production readiness is declared per module** based on real-infrastructure integration and fault-injection tests (see `docs/support-policy.md`, `docs/public-api-matrix.md`, `docs/production-preview.md` in the repository, and [Deployment & Production](/recipes/deployment)):

| Stability Tier | Packages / Scope | Qualification Criteria |
| --- | --- | --- |
| **Production Preview (`0.1`)** | `@bunest/core` (HTTP, DI, Config), `@bunest/validation`, `@bunest/orm` (PostgreSQL via `Bun.SQL`, explicit migrations), `@bunest/observability` (logging, health, metrics) on **Linux** | Pinned Linux CI green, real PostgreSQL persistence/migration/outage/backup smoke suite, 2h soak gate (`p95 < 200 ms`, `5xx < 0.1%`, stable RSS), `< 5 min` rollback rehearsal, clean out-of-repo registry install |
| **Beta (Integration-Verified)** | `@bunest/cache`, `@bunest/jobs`, `@bunest/security`, `@bunest/swagger`, `@bunest/testing`, `@bunest/cli`, `@bunest/resilience`, `@bunest/orm` (SQLite) | Full unit & conformance coverage + real-service integration tests (Redis / SQLite) in CI |
| **Preview / Experimental** | `@bunest/graphql`, `@bunest/microservices`, `@bunest/messaging`, `@bunest/workflows`, `@bunest/storage`, `@bunest/mail`, `@bunest/elasticsearch`, `@bunest/ai`, non-PostgreSQL `Bun.SQL` dialects (MySQL/MariaDB/MongoDB/LibSQL/D1) | Functional with 100% conformance / unit tests; awaiting dedicated real-service fault-injection & soak verification before promotion |

---

## 4. Implemented Monorepo Capabilities (Phased Breakdown)

All phases below are **implemented in the `0.1.0` monorepo** across the 19 `@bunest/*` packages (see [Packages & Monorepo](/ecosystem/packages) for the complete subpath map):

### Phase 0 — Foundation _(Implemented)_

- [x] Architecture Decision Records (`ADR-001` – `ADR-018`) & `RFC-001` locked (see [ADR & RFC Index](/architecture/adrs))
- [x] `@bunest/core` (including `./common` decorators, metadata registry, strict DI & `@Module()` graph) and `@bunest/validation` (including mapped DTO helpers) with 100% ADR-adjusted NestJS v12.5.1 parity

### Phase 1 — HTTP Core & NestJS v12 Parity _(Implemented)_

- [x] `@bunest/core/http`: Bun-native `AbstractHttpAdapter` & `BunHttpAdapter`, hybrid `Bun.serve({ routes })` + `FallbackRadixRouter`, `ServeStaticModule`, Fetch-Metadata CSRF, Helmet-8 security headers, HMAC-SHA256 signed cookies, `@Render()`, API Versioning, `CompressionMiddleware`, `useStaticAssets`, `@UseMiddleware`

### Phase 2 — Developer Experience _(Implemented)_

- [x] `@bunest/testing`, `@bunest/core/config`, `@bunest/cli`, `@bunest/swagger`, `@bunest/core/client`, `@bunest/core/i18n`, `@bunest/mail`, `@bunest/storage`

### Phase 3 — Security, Identity & Data Persistence _(Implemented)_

- [x] `@bunest/security` (`SecurityModule.forRoot()`, `JwtModule`, `PassportModule`, `ThrottlerModule`), `@bunest/security/auth`, `@bunest/security/authz`
- [x] `@bunest/orm` (12 dialects over `bun:sqlite`, `Bun.SQL`, `fetch()`, and `Bun.connect()`, plus `./plugin`, `./store`, `./postgres`, `./mysql`, `./testing` subpaths), `@bunest/elasticsearch`

### Phase 4 — Realtime, Distributed Systems, AI & Observability _(Implemented)_

- [x] `@bunest/core/ws`, `@bunest/graphql`, `@bunest/graphql/apollo`
- [x] `@bunest/messaging/events`, `@bunest/jobs/scheduler`, `@bunest/cache`, `@bunest/jobs/queues` (`QueueModule`, `BullModule`/`BullMQModule`), `@bunest/messaging/cqrs`, `@bunest/microservices`
- [x] `@bunest/resilience`, `@bunest/resilience/locks`, `@bunest/resilience/idempotency`, `@bunest/messaging/outbox`, `@bunest/messaging/webhooks`, `@bunest/workflows`
- [x] `@bunest/ai`, `@bunest/ai/mcp`
- [x] `@bunest/observability` (`ObservabilityModule`, `TerminusModule`/`HealthModule`, `DevtoolsModule`)

### Phase 5 — Service-Layer AOP, Zero-Dep Consolidation & Declarative Repositories _(Implemented)_

- [x] Zero-overhead `DIContainer` `MethodAspectWeaver` (`O(1)` `WeakMap` skip for undecorated classes, `ADR-014`)
- [x] Compiled-once declarative repositories in `@bunest/orm` (`@Repository`/`CrudRepository`) with derived finders, `@Query`/`@Modifying`/`@SqlParam`, `@Transactional`, and `OrmMigrationRunner`
- [x] Zero-external-dependency DTO validation/transformation (`ADR-015`), 6-domain 19-package consolidation (`ADR-016`), 19/19 zero-dep runtime & 2-adapter `node:*` quarantine (`ADR-017`), and customizable magic/plugin architecture (`ADR-018`)
- [x] Public reproducible 8-target head-to-head benchmark suite comparing Bunest vs raw `Bun.serve()` vs NestJS v12 on Bun & Node.js

---

## 5. Historical Pre-Consolidation Milestones

Earlier repository documents and `CHANGELOG.md` entries reference internal pre-release milestones (`v0.1`, `v0.2`, `v0.5`, `v0.8`) and larger pre-consolidation workspace layouts (**22 → 53 → 35/37** packages before `ADR-016`). Those were **historical internal implementation stages**, never separately published npm tags or release lines:

| Historical Label | Released npm Tag? | What It Represented | Current Equivalent in `0.1.0` |
| --- | --- | --- | --- |
| **Internal `v0.1` / `v0.2`** | No (internal stage) | Initial 22-package foundation + NestJS v12 parity (`DiscoveryService`, API Versioning, `RouterModule`, Durable DI, `StandardSchemaV1`, etc.) | Consolidated into `@bunest/core`, `@bunest/validation`, and core ecosystem packages |
| **Internal `v0.5` (53 → 35/37 pkgs)** | No (internal stage) | Full NestJS v12 ecosystem expansion (53 packages including thin `@nestjs/*` facades, later trimmed to 35/37 before `ADR-016`) | Consolidated via `ADR-016` into **19 domain packages** with tree-shakeable ESM subpaths (`@bunest/core/*`, `@bunest/security/*`, `@bunest/messaging/*`, `@bunest/jobs/*`, `@bunest/resilience/*`, `@bunest/orm/*`, `@bunest/ai/*`) |
| **Internal `v0.8`** | No (internal stage) | Service-layer AOP (`ADR-014`), `@bunest/orm` declarative repositories, zero-dep validation (`ADR-015`), and 19/19 zero external runtime deps (`ADR-017`) | Shipped as the baseline of **`0.1.0 Production Preview`** |

---

## 6. Benchmark Integrity Policy

Bunest never publishes unverified _"X times faster"_ marketing claims. Every benchmark published for Bunest must disclose:

1. Exact Bun version, OS, CPU, RAM, and package versions.
2. Route count, payload size, concurrency, keep-alive, warmup, and duration.
3. Equivalent middleware/validation/logging configurations across frameworks.
4. Throughput (req/s), latency `p50`/`p95`/`p99`, CPU, memory/RSS, and error rate—with reproducible scripts committed in the repository.
