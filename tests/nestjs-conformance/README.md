# NestJS Full 22-Package Conformance Test Suite for Bunest

This directory contains the permanent **NestJS Core + Ecosystem conformance test suite** ported directly from **20 official [`github.com/nestjs/*`](https://github.com/nestjs) repositories** (plus 9 dedicated Devtools & Bun-native persistence parity specs) onto **Bunest** (`bun:test` + all **22 / 22** `@bunest/*` workspace packages).

- **Upstream Repositories Audited:** **20 cloned official `github.com/nestjs/*` repositories** (`nestjs/nest` v12.5.1 + 19 official ecosystem repos: `axios`, `cache-manager`, `config`, `cqrs`, `event-emitter`, `mapped-types`, `schedule`, `swagger`, `graphql`, `jwt`, `throttler`, `passport`, `bull`, `terminus`, `nest-cli`, `schematics`, `typeorm`, `drizzle`, `observe`, plus closed-source npm `@nestjs/devtools-integration@12.0.0` covered via supplemental parity specs)
- **Audit Scope:** **1,313 upstream test files** audited (**15,437** call-site / **17,339** expanded tests) — **635** core (`nestjs/nest`) + **345** Phase 2 Group A + **333** Phase 2 Group B
- **Ported & Supplemental Coverage:** **678 conformance spec files** (`180 DIRECT_PORT` + `489 ADAPTED_PORT` + `9 SUPPLEMENTAL`) across **16 non-overlapping buckets** (8 core + 8 ecosystem), plus 1 harness self-test (`_helpers/verify-helpers.spec.ts`) = **679 spec files** (**702 `.ts` files** total)
- **Bunest Package Coverage:** **21 / 21 core & ecosystem conformance packages covered** (`axios`, `cache`, `cli`, `common`, `config`, `core`, `cqrs`, `events`, `graphql`, `http`, `mapped-types`, `microservices`, `observability`, `orm`, `queues`, `scheduler`, `security`, `swagger`, `testing`, `validation`, `websockets`)
- **Live Combined Suite Metrics (`bun test tests/nestjs-conformance`):** **5,076 pass / 2,030 skip (`1,766 / 1,766` annotated `// BUNEST_BUG:`) / 0 fail / 12,008 `expect()` calls** across **679 files** (7,106 tests, 100% deterministic across consecutive runs, **0 TS errors** across all 702 conformance `.ts` files and all 1,581 repo files)
- **Excluded Upstream Files:** **644 files** (`299` core + `118` Group A + `227` Group B — Express/Fastify/Socket.IO/Mercurius/compiler-plugin/webpack/Angular-Tree/Observe-SaaS internals, duplicate adapter-matrix variants, and live Docker daemon suites; every file is individually cataloged in [`inventory.json`](./inventory.json) and [`CONFORMANCE_REPORT.md`](./CONFORMANCE_REPORT.md))

---

## Directory Layout

```text
tests/nestjs-conformance/
├── README.md                          # Developer guide (this file)
├── CONFORMANCE_REPORT.md              # Full 22-package coverage matrix, live metrics & deduplicated Bunest bug registry
├── inventory.json                     # Unified machine-readable audit of all 20 repos, 1,313 upstream files, 9 supplemental specs & live verification
├── _helpers/                          # Shared conformance harness (ADR metadata, HTTP/test wrappers, Sinon-like spies; 1 spec)
│   ├── index.ts
│   ├── conformance-meta.ts
│   ├── http-helpers.ts
│   ├── spy-helpers.ts
│   └── verify-helpers.spec.ts
│
├── # Phase 1 — NestJS Core (8 buckets, 336 spec files from nestjs/nest v12.5.1)
├── common/                            # bucket-1 (72 files): decorators, 22 HTTP exceptions, pipes, file validators, ValidationPipe, Standard Schema, serializers, Logger/redaction, utils
├── di-lifecycle-testing/              # bucket-2 (59 files): DI/injector, forwardRef, lifecycle hooks, graceful shutdown, lazy modules, Discovery, ConfigurableModuleBuilder, GraphInspector, REPL, @bunest/testing
├── http-pipeline/                     # bucket-3 (43 files): guards, Promise interceptors, pipes, exception filters, BaseExceptionFilter, RouterModule, global prefix, MiddlewareConsumer, ExternalContextCreator
├── http-features/                     # bucket-4 (32 files): cookies & signed cookies, CSRF, security headers, CORS, multipart upload, StreamableFile, SSE, Web Response/ReadableStream streaming, rawBody, @QueryMethod, @Render, wildcards
├── routing-versioning/                # bucket-5 (14 files): URI/Header/Media-Type/Custom versioning, route conflict policy, conflict detection, specificity sorting
├── scopes-core/                       # bucket-6 (37 files): REQUEST/TRANSIENT scopes, durable sub-trees, ADR-012 ScopeLeakException, ApplicationConfig, Reflector, DiscoveryService, ModulesContainer, LazyModuleLoader
├── websockets-graphql-tcp/            # bucket-7 (55 files): @bunest/websockets gateways/filters/guards/pipes, @bunest/graphql baseline e2e, @bunest/microservices TCP transport & core framing/decorators
├── microservices-transports/          # bucket-8 (24 files): gRPC (in-process), Kafka, MQTT, NATS, Redis, RabbitMQ client/server/serializer/context conformance
│
└── ecosystem/                         # Phase 2 — Official NestJS Ecosystem + Bun-Native Persistence (8 buckets, 342 spec files)
    ├── axios/                         # eco-bucket-1 (2 of 66): @bunest/axios HttpModule & HttpService e2e
    ├── cache/                         # eco-bucket-1 (10 of 66): @bunest/cache CacheModule, CacheInterceptor, multi-store, TTL, SSE, streaming, shutdown
    ├── config/                        # eco-bucket-1 (29 of 66): @bunest/config ConfigModule/ConfigService, .env expansion, registerAs, ConditionalModule, Standard Schema validation
    ├── cqrs/                          # eco-bucket-1 (10 of 66): @bunest/cqrs CommandBus, QueryBus, EventBus, sagas, AggregateRoot, scoping, Explorer
    ├── events/                        # eco-bucket-1 (3 of 66): @bunest/events EventEmitterModule, priority, wildcards, request-scoped listeners
    ├── mapped-types/                  # eco-bucket-1 (5 of 66): @bunest/mapped-types PartialType, PickType, OmitType, IntersectionType (single & multi)
    ├── scheduler/                     # eco-bucket-1 (7 of 66): @bunest/scheduler @Cron/@Interval/@Timeout, SchedulerRegistry, waitForCompletion, shutdown
    ├── swagger/                       # eco-bucket-2 (38 files): @bunest/swagger OpenAPI 3.0/3.1/3.2 schema explorer, decorators, mapped types, Standard Schema, SwaggerModule UI
    ├── graphql/
    │   ├── unit/                      # eco-bucket-3 (60 files): @bunest/graphql decorators, schema builders, directives, extensions, mapped types, AST/definitions factories
    │   ├── e2e/                       # eco-bucket-4 (58 of 63): @bunest/graphql code-first, schema-first, federation/subgraph, guards/pipes/filters/scopes e2e
    │   └── subscriptions/             # eco-bucket-4 (5 of 63): @bunest/graphql graphql-ws & SSE subscriptions
    ├── security/                      # eco-bucket-5 (12 of 21): @bunest/security JwtModule/JwtService, ThrottlerModule/ThrottlerGuard, Passport AuthGuard/AuthStrategy
    ├── queues/                        # eco-bucket-5 (9 of 21): @bunest/queues BullModule/BullMQ decorators, explorer, durable/request-scoped processors, pluggable backends, shutdown
    ├── observability/                 # eco-bucket-6 (35 files): @bunest/observability Terminus health indicators & e2e (27), Observe tracing/metrics/OTLP/redaction (7), Devtools parity (1)
    ├── cli/                           # eco-bucket-7 (37 files): @bunest/cli nest-cli commands/config/metadata plugin (16) + schematics generators (21)
    └── persistence/                   # eco-bucket-8 (17 files): @bunest/orm TypeORM DI patterns (9) + Bun-native ORM drivers/ACID/SAVEPOINT/ALS/migrations/repositories/security/store-kit (8)
```

---

## Running the Suite

### Run the entire 22-package conformance suite (679 files)

```bash
bun test tests/nestjs-conformance
```

### Run all Phase 1 (Core) or Phase 2 (Ecosystem) buckets

```bash
# Phase 1 — Core (336 files) + harness (1 file)
bun test tests/nestjs-conformance/common tests/nestjs-conformance/di-lifecycle-testing tests/nestjs-conformance/http-pipeline tests/nestjs-conformance/http-features tests/nestjs-conformance/routing-versioning tests/nestjs-conformance/scopes-core tests/nestjs-conformance/websockets-graphql-tcp tests/nestjs-conformance/microservices-transports tests/nestjs-conformance/_helpers

# Phase 2 — Ecosystem (342 files)
bun test tests/nestjs-conformance/ecosystem
```

### Run an individual bucket

```bash
# Phase 1 Core buckets
bun test tests/nestjs-conformance/common
bun test tests/nestjs-conformance/di-lifecycle-testing
bun test tests/nestjs-conformance/http-pipeline
bun test tests/nestjs-conformance/http-features
bun test tests/nestjs-conformance/routing-versioning
bun test tests/nestjs-conformance/scopes-core
bun test tests/nestjs-conformance/websockets-graphql-tcp
bun test tests/nestjs-conformance/microservices-transports
bun test tests/nestjs-conformance/_helpers

# Phase 2 Ecosystem buckets
bun test tests/nestjs-conformance/ecosystem/axios tests/nestjs-conformance/ecosystem/cache tests/nestjs-conformance/ecosystem/config tests/nestjs-conformance/ecosystem/cqrs tests/nestjs-conformance/ecosystem/events tests/nestjs-conformance/ecosystem/mapped-types tests/nestjs-conformance/ecosystem/scheduler
bun test tests/nestjs-conformance/ecosystem/swagger
bun test tests/nestjs-conformance/ecosystem/graphql/unit
bun test tests/nestjs-conformance/ecosystem/graphql/e2e tests/nestjs-conformance/ecosystem/graphql/subscriptions
bun test tests/nestjs-conformance/ecosystem/security tests/nestjs-conformance/ecosystem/queues
bun test tests/nestjs-conformance/ecosystem/observability
bun test tests/nestjs-conformance/ecosystem/cli
bun test tests/nestjs-conformance/ecosystem/persistence
```

### Typecheck conformance specs (`bun check`)

Because the workspace root `tsconfig.json` excludes `tests/`, pass conformance `.ts` files explicitly to `bun check` (which uses Bun's strict `verbatimModuleSyntax: true`, `strict: true`, `noUncheckedIndexedAccess: true`, and legacy decorator settings):

```bash
# POSIX / macOS / Linux
bun check $(find tests/nestjs-conformance -name '*.ts')

# Windows PowerShell (chunked to stay below command-line length limits)
$files = Get-ChildItem -Recurse -Filter *.ts tests/nestjs-conformance | ForEach-Object { $_.FullName }
for ($i = 0; $i -lt $files.Count; $i += 150) {
  $batch = $files[$i..([Math]::Min($i + 149, $files.Count - 1))]
  bun check @batch
}
```

---

## Shared Harness (`_helpers/`)

All conformance specs import shared test utilities from `tests/nestjs-conformance/_helpers`:

| Module                | Key Exports                                                                                                                                                                                                                                              | Purpose                                                                                                                                                                                                                                                              |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `conformance-meta.ts` | `describeConformance()`, `itAdapted()`, `BUNEST_ADRS`, `adrTag()`, `expectScopeLeak()`, `expectValidationErrorEnvelope()`, `expectNestValidationErrorEnvelope()`                                                                                         | Tags every suite with its upstream path, classification (`DIRECT_PORT` / `ADAPTED_PORT`), and governing Bunest ADR(s), plus standard assertions for ADR-012 scope leaks and ADR-009 validation envelopes.                                                            |
| `http-helpers.ts`     | `Test`, `TestingModule`, `TestingModuleBuilder`, `request` / `httpRequest`, `createTestApp()`, `withTestApp()`, `nestCompatibleValidationPipe()`, `bunestStrictValidationPipe()`, `CapturingLogger`, `TestingLogger`, `ModuleMocker`, `ContextIdFactory` | Re-exports `@bunest/testing` zero-socket HTTP / DI helpers and provides `nestCompatibleValidationPipe()` (`whitelist: false`, `forbidNonWhitelisted: false`, `transform: false`, `errorFormat: "list"`) alongside `bunestStrictValidationPipe()` (ADR-009 defaults). |
| `spy-helpers.ts`      | `createSpy()`, `spyOnMethod()`, `createStub()`, `stubMethod()`, `createSandbox()`, `match`, `expectCalled*()`                                                                                                                                            | Lightweight Sinon/Chai-compatible spy, stub, matcher, and sandbox wrappers backed by `bun:test` `mock()` / `spyOn()`.                                                                                                                                                |

---

## Import & Authoring Conventions

1. **`.spec.ts` / `.e2e.spec.ts` discovery naming:** Bun's test runner ignores hyphenated `*-spec.ts` filenames and auto-discovers only `*.spec.ts` / `*.test.ts`. All upstream `.e2e-spec.ts` files are normalized to `.e2e.spec.ts` so `bun test tests/nestjs-conformance` executes 100% (679 / 679) of spec files automatically.
2. **`import "reflect-metadata";` first:** Every spec file begins with `import "reflect-metadata";` on line 1 to guarantee decorator metadata reflection under Bun (ADR-002).
3. **`verbatimModuleSyntax: true`:** Classes/DTOs/providers used in decorator metadata (`design:paramtypes`, `@Body()`, DI constructors) MUST be value-imported; interfaces and type-only symbols MUST use `import type` (ADR-002).
4. **Direct relative package imports:** Because Bun's isolated workspace linker does not hoist `@bunest/*` into root `node_modules/`, conformance tests import workspace packages directly via relative paths to `packages/<pkg>/src` (and `packages/graphql/node_modules/graphql` for GraphQL AST/SDL assertions).
5. **Zero external daemons & zero hardcoded ports:** Live HTTP/WS/gRPC/TCP/GraphQL tests bind ephemeral loopback ports (`listen(0, "127.0.0.1")` / `port: 0`) and clean up in `afterEach`/`afterAll`. Queue, broker, cache, and persistence tests execute completely offline using `MemoryQueueDriver`, `MemoryCacheStore`, `:memory:` / cleaned `os.tmpdir()` SQLite DBs, and structural client mocks — zero Docker, Postgres, MySQL, or Redis daemons required.

---

## Intentional ADR Divergences vs. Bunest Bugs

### Intentional Bunest ADR Divergences (`ADAPTED_PORT` / `itAdapted`)

Where Bunest intentionally departs from NestJS by architecture, tests are tagged with `itAdapted("ADR-XXX", ...)` and verify **Bunest's documented contract** (see `docs/adr/ADR-001.md` through `docs/adr/ADR-013.md`):

- **ADR-001 / ADR-010:** Native `Bun.serve()`, Web Standard `Request`/`Response`, `fetch()`, `Bun.SQL` / `bun:sqlite`, mutable `ResponseContext` (`@Res()`), zero Express/Fastify/Multer/Socket.IO/Axios/Keyv/Redis-client runtime dependencies.
- **ADR-002:** `verbatimModuleSyntax: true` with legacy decorators.
- **ADR-005:** Zero-dep Standard Schema v1 (`~standard`) validation and native magic-byte file sniffing alongside `class-validator` / `class-transformer` interop.
- **ADR-007 §6:** Circular `forwardRef()` cycles are permitted for singleton class providers only; circular `useFactory` and `Scope.REQUEST` `forwardRef()` cycles fail fast with `CircularDependencyException`.
- **ADR-008:** Zero-RxJS Promise-based 11-stage onion pipeline (`CallHandler.handle(): Promise<T>`, Promise `HttpService`, Promise CQRS buses/sagas); `AsyncIterable` / `ReadableStream` for SSE, GraphQL subscriptions, and streaming.
- **ADR-009:** `ValidationPipe` defaults to strict security (`whitelist: true`, `forbidNonWhitelisted: true`, `forbidUnknownValues: true`, `transform: true`, `{ statusCode, error, message: "Validation failed", details }`). Upstream tests targeting NestJS defaults use `nestCompatibleValidationPipe()` and also verify strict ADR-009 defaults.
- **ADR-011:** Hybrid `Bun.serve({ routes })` + `FallbackRadixRouter` with O(1) `405 Method Not Allowed` + `Allow` header and fail-fast `DuplicateRouteException` by default.
- **ADR-012:** Fail-fast `ScopeLeakException` at bootstrap whenever a `Scope.SINGLETON` depends on a `Scope.REQUEST` provider (no silent scope bubbling); consumers must explicitly declare `{ scope: Scope.REQUEST }` or read ambient `RequestContext`/`ClsService`.

### Genuine Bunest Bugs & Parity Gaps (`// BUNEST_BUG:`)

Whenever an upstream NestJS test exposes a **genuine Bunest bug or unimplemented API** (not an intentional ADR divergence):

1. The full, faithful upstream test code and assertions are preserved verbatim — **never weakened or faked to pass**.
2. Only the failing `it(...)` (or `it.each(...)` / `describe(...)`) is marked `it.skip(...)` with an immediately preceding `// BUNEST_BUG: <expected vs actual & suspected package/file>` comment.
3. As Bunest fixes each bug in `packages/*/src/`, simply un-skip the corresponding test(s) and verify green under `bun test tests/nestjs-conformance`.

See [`CONFORMANCE_REPORT.md`](./CONFORMANCE_REPORT.md) for the complete 22-package coverage matrix, 20-repo snapshot audit, and deduplicated bug registry prioritized by severity (`P0`/`P1`/`P2`) across all Bunest packages.
