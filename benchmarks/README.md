# Bunest Benchmarks

Reproducible performance benchmarks comparing **Bunest** (`@bunest/core` + `@bunest/http` + `@bunest/validation`) against raw **`Bun.serve()`** under identical workloads and runtime conditions.

## Running the Benchmarks

```bash
# Run full benchmark suite and regenerate benchmarks/RESULTS.md
bun run benchmarks/run.ts

# Quick smoke run (fewer iterations)
bun run benchmarks/run.ts --quick

# Custom parameters
bun run benchmarks/run.ts --requests 5000 --concurrency 64 --iterations 20000
```

## Workloads Measured

1. **Static `GET /health`** — Minimal JSON response (`{ "status": "ok" }`), measuring baseline routing + serialization overhead.
2. **Parameterized `GET /users/:id` + DI** — Dynamic path parameter extraction (`@Param("id")`) + singleton constructor-injected service lookup.
3. **JSON `POST /users`** — JSON body parsing (`@Body()`) + default `201 Created` serialization without DTO validation.
4. **Validated `POST /users/validated`** — Full `ValidationPipe` (`class-transformer` `plainToInstance` + `class-validator` `validate`) with conservative ADR-009 defaults (`whitelist`, `forbidNonWhitelisted`, `forbidUnknownValues`, prototype-pollution guard) compared against raw `Bun.serve()` running the exact same `ValidationPipe`.
5. **DI & Bootstrap Microbenchmarks** — Cold application bootstrap (`ModuleScanner` + `DIContainer` + route compilation + `init()`), hot singleton `app.get()`, hot transient `app.resolve()`, and full `Scope.REQUEST` container create/resolve/destroy lifecycle.

## Methodology & Disclosure

- **Dual measurement modes:**
  - **Live loopback HTTP** (`Bun.serve({ hostname: "127.0.0.1", port: 0 })` with `keep-alive` concurrent workers) measures realistic end-to-end HTTP performance.
  - **In-process `fetch()` dispatch** (`10,000` iterations) removes OS loopback TCP/socket variance to expose Bunest's pure per-request framework overhead.
- **Fair configuration:** Logging is disabled (`logger: false`) on Bunest to match silent raw `Bun.serve()`. Both suites execute identical warmup phases before measuring latencies with `Bun.nanoseconds()`.
- **Full transparency:** Every run records exact Bun version/revision, OS/arch, CPU model/cores, RAM, package versions, concurrency, payload size, throughput (req/s), latency `p50`/`p95`/`p99` (ms), RSS (MB), and error rate (%) into [`benchmarks/RESULTS.md`](./RESULTS.md).
