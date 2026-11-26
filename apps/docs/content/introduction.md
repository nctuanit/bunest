# Build a TypeScript REST API on Bun

**Bunest** gives TypeScript backend teams NestJS-style `@Controller()` routing, strict constructor dependency injection, and secure-by-default DTO validation directly on **Bun** (`>= 1.4.5`)—with zero Express, Fastify, or RxJS overhead.

**[Run your first API ->](/overview/first-steps)**

The snippet below is a **controller excerpt** from `examples/hello-world/src/app.module.ts`, using the exact `/health` endpoint you will boot and verify in [First steps](/overview/first-steps):

@@filename(examples/hello-world/src/app.module.ts)

```ts
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(@Query("name") name?: string) {
    return this.appService.getGreeting(name);
  }

  @Get("/health")
  getHealth() {
    return { status: "ok" };
  }
}
```

```bash
curl http://localhost:3000/health
```

```json
{"status":"ok"}
```

## Choose your next reading path

- **[Coming from NestJS](/architecture/migration-from-nestjs)** — See what maps 1:1 (`@Module()`, `@Controller()`, `@Injectable()`, guards, pipes, filters) and what changes on Bun (native `Bun.serve()`, Promise interceptors instead of RxJS, and consolidated `@bunest/*` packages).
- **[How a request flows through the framework](/architecture/execution-pipeline)** — Inspect the 11-stage HTTP execution pipeline compiled once at bootstrap into native `Bun.serve({ routes })` closures with zero per-request reflection.

## At a glance

@@component(hero-cards)

## Pipeline & Architecture

- **[11-Stage Execution Pipeline](/architecture/execution-pipeline)** — Normative request lifecycle from route matching through middleware, guards, Promise onion interceptors, parameter extraction, validation pipes, handler execution, response serialization, and exception filters.
- **[Hybrid Bun.serve Router](/architecture/hybrid-router)** — How controllers compile into native `Bun.serve({ routes })` Zig closures plus a controlled fallback radix router with fail-fast duplicate route detection.
- **[Response Serialization](/architecture/response-serialization)** — Native Web `Response` passthrough, zero-copy `Bun.file()`, SSE streams, and RFC 9110 empty-body enforcement.
- **[Secure-by-Default Validation](/techniques/validation)** — `ValidationPipe` defaults to `whitelist: true`, `forbidNonWhitelisted: true`, prototype-pollution rejection, and Standard Schema support.

## Architecture Decision Records (ADRs)

> info **Architectural Contract** Bunest is **Bun-only** (`Bun >= 1.4.5`, [ADR-001 through ADR-018](/architecture/adrs)). Core packages run directly on Web Standards (`Request`, `Response`, `Headers`, `ReadableStream`, WebCrypto) and native Bun primitives (`Bun.serve`, `Bun.SQL`, `bun:sqlite`, `Bun.file`, `Bun.password`, `bun:test`) with **zero external runtime dependencies** across all 19 packages (`ADR-017`).

Browse the full [ADR & RFC Index](/architecture/adrs) to review binding design contracts for legacy decorators (`ADR-002`), compile-at-bootstrap routing (`ADR-011`), strict scope-leak prevention (`ADR-012`), Service-Layer AOP (`ADR-014`), and the 6-domain package consolidation (`ADR-016`).

## Benchmarks

Bunest never publishes unverified _"X times faster"_ claims. Every published result follows the reproducible 8-target head-to-head methodology (disclosing exact Bun version, OS, hardware, concurrency, latency `p50`/`p95`/`p99`, RSS, and error rates) documented in the [Benchmark Integrity Policy](/ecosystem/roadmap).

## Support Policy & Ecosystem

- **Current Release:** **`0.1.0` Production Preview** across all **19 lockstep `@bunest/*` packages** targeting **Bun `>= 1.4.5`**.
- **Production Preview Scope:** Linux + Bun `1.4.5` REST APIs with `@bunest/core`, `@bunest/validation`, `@bunest/orm` (PostgreSQL via `Bun.SQL`, explicit migrations), and `@bunest/observability`.
- **Explore further:** Read the [Implementation Roadmap & Support Scope](/ecosystem/roadmap), browse all 19 packages in [Packages & Monorepo](/ecosystem/packages), or review production operations in [Deployment & Production](/recipes/deployment).
