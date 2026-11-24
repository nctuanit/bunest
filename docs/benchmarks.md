# Benchmarks & Performance

Bunest follows strict, reproducible benchmarking discipline: **never publish extrapolated claims**, always disclose hardware/runtime/config, and measure Bunest directly against raw **`Bun.serve()`** on identical workloads.

All numbers below were measured directly via `bun run benchmarks/run.ts` and recorded verbatim in [`benchmarks/RESULTS.md`](../benchmarks/RESULTS.md). For the 8-target head-to-head comparison against real upstream NestJS `v12.5.1` (Platform Node, Fastify, Express on both Bun and Node.js), see [`benchmarks/nestjs-comparison/RESULTS.md`](../benchmarks/nestjs-comparison/RESULTS.md) and [`docs/nestjs-comparison.md`](./nestjs-comparison.md).

---

## 1. Methodology & Disclosure

- **Dual measurement modes:**
  1. **Live loopback HTTP** (`Bun.serve({ hostname: "127.0.0.1", port: 0 })`, HTTP/1.1 `keep-alive`, concurrency 32, 4,000 requests after 400 warmup requests) captures full end-to-end HTTP stack behavior including TCP loopback sockets.
  2. **In-process `fetch()` dispatch** (10,000 iterations after 1,000 warmup iterations, concurrency 1) removes OS loopback socket overhead to isolate Bunest's pure route dispatch, parameter extraction, DI, and serialization overhead.
- **Fair configuration:** Logging is disabled (`logger: false`) on Bunest to match silent raw `Bun.serve()`. On the validated DTO workload, raw `Bun.serve()` executes the exact same `ValidationPipe` (`class-transformer` + `class-validator`) as Bunest.
- **High-resolution timing:** Per-request latencies are recorded with `Bun.nanoseconds()` and summarized as `p50`, `p95`, `p99`, RSS (MB), and error rate (%).

### Recorded Environment ([`benchmarks/RESULTS.md`](../benchmarks/RESULTS.md))

| Property             | Value                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| Measured At (UTC)    | `2026-11-20T07:49:29.185Z`                                                                      |
| Bun Runtime          | `v1.4.3` (`c6da4a4d`)                                                                           |
| OS / Arch            | `win32 10.0.26300 (x64)`                                                                        |
| CPU                  | `AMD Ryzen 7 5800H with Radeon Graphics` (16 logical cores)                                     |
| Total RAM            | `63.36 GiB`                                                                                     |
| Package Versions     | `@bunest/core@0.1.0`, `class-validator@0.14.4`, `class-transformer@0.5.1`                       |
| Live HTTP Config     | 4,000 req/workload, 400 warmup, concurrency 32, `keep-alive`, 59-byte JSON payload, logging off |
| In-Process Config    | 10,000 ops/workload, 1,000 warmup, concurrency 1                                                |
| DI Microbench Config | 10,000 hot ops, 50 cold bootstraps                                                              |

---

## 2. Live Loopback HTTP (`Bun.serve({ port: 0 })`, Concurrency 32)

| Workload                                   | Raw `Bun.serve` (req/s) | Bunest (req/s) | Relative Throughput | Bunest p50 (ms) | p50 Overhead (ms) | Bunest p99 (ms) | p99 Overhead (ms) | Errors |
| ------------------------------------------ | ----------------------: | -------------: | ------------------: | --------------: | ----------------: | --------------: | ----------------: | -----: |
| 1. Static `GET /health`                    |                  33,682 |     **33,278** |           **98.8%** |           0.900 |            +0.055 |           2.051 |            -0.027 |  0.00% |
| 2. Param `GET /users/:id` + DI             |                  34,508 |     **32,045** |           **92.9%** |           0.941 |            +0.084 |           1.792 |            -0.132 |  0.00% |
| 3. JSON `POST /users` (`@Body`)            |                  25,999 |     **21,147** |           **81.3%** |           1.401 |            +0.254 |           2.930 |            +0.223 |  0.00% |
| 4. Validated `POST /users/validated` (DTO) |                  12,149 |     **12,756** |          **105.0%** |           2.316 |            -0.062 |           4.077 |            -0.187 |  0.00% |

---

## 3. In-Process `fetch()` Dispatch Microbenchmark (10,000 ops)

| Workload                                   | Raw `Bun.serve` (req/s) | Bunest (req/s) | Relative Throughput | Bunest p50 (ms) | p50 Overhead (ms) | Bunest p99 (ms) | p99 Overhead (ms) | Errors |
| ------------------------------------------ | ----------------------: | -------------: | ------------------: | --------------: | ----------------: | --------------: | ----------------: | -----: |
| 1. Static `GET /health`                    |                 473,317 |    **341,247** |           **72.1%** |           0.002 |            +0.001 |           0.014 |            +0.006 |  0.00% |
| 2. Param `GET /users/:id` + DI             |                 560,058 |    **260,223** |           **46.5%** |           0.003 |            +0.002 |           0.017 |            +0.011 |  0.00% |
| 3. JSON `POST /users` (`@Body`)            |                 291,643 |     **33,639** |           **11.5%** |           0.009 |            +0.006 |           0.873 |            +0.856 |  0.00% |
| 4. Validated `POST /users/validated` (DTO) |                  54,668 |     **18,295** |           **33.5%** |           0.023 |            +0.009 |           1.160 |            +1.110 |  0.00% |

---

## 4. DI Container & Bootstrap Microbenchmarks

| Operation                                                | Iterations | Throughput (ops/s) | p50 (ms) | p95 (ms) | p99 (ms) | RSS (MB) |
| -------------------------------------------------------- | ---------: | -----------------: | -------: | -------: | -------: | -------: |
| Cold bootstrap (scan + DI + route compile + init)        |         50 |              1,987 |   0.3675 |   0.8238 |   3.3632 |    122.7 |
| Hot singleton DI lookup (`app.get`)                      |     10,000 |          1,811,988 |   0.0004 |   0.0007 |   0.0014 |    123.1 |
| Hot transient DI resolve (`app.resolve`)                 |     10,000 |            110,042 |   0.0070 |   0.0161 |   0.0224 |    137.3 |
| Request-scoped DI lifecycle (create + resolve + destroy) |     10,000 |            157,979 |   0.0051 |   0.0091 |   0.0167 |    136.5 |

---

## 5. Overhead Analysis (Post-P0 #2 Optimization)

1. **Near-native throughput on read routes (`92.9%–98.8%` of raw `Bun.serve()`):** Static `GET /health` reaches **33,278 req/s** (`98.8%` of raw `Bun.serve()`, **`+0.055 ms`** live p50, **`+0.001 ms`** in-process p50 / **341,247 ops/s**) and parameterized `GET /users/:id` + DI reaches **32,045 req/s** (`92.9%`, **`+0.002 ms`** in-process p50 / **260,223 ops/s**). Singleton routes with no middleware, `@Res()`, or request-scoped dependencies run through the compiled `executeFastSingletonRoute` fast-path—preserving `AsyncLocalStorage` with a lean lazy `RequestContext` while eliminating unnecessary `Promise`, `HttpResponseContext`, `Headers`, and `HttpExecutionContext` allocations and emitting directly with `Response.json(result, { status })`.
2. **Major JSON `POST` speedup via 1-pass parsing & sanitization (`38.8% → 81.3%` live relative throughput):** Compared to the pre-optimization baseline (`10,837 req/s`, `38.8%` of raw), `POST /users` (`@Body`) now hits **21,147 req/s** (**`81.3%`** of raw `Bun.serve()`, `+0.254 ms` live p50, `+0.006 ms` in-process p50) while preserving full body-limit enforcement and prototype-pollution protection. This comes from taking the direct `await req.text()` fast-path whenever `Content-Length <= maxBodyBytes` (skipping `ReadableStreamDefaultReader` allocation) and checking dangerous keys (`__proto__`/`constructor`/`prototype`) in a single pass.
3. **Zero double-sanitization overhead on validated DTOs (`105.0%` live relative throughput):** Because `@bunest/http` tags already-verified parsed JSON payloads with `BODY_SANITIZED_SYMBOL`, `ValidationPipe` skips redundant recursive key-walking and reaches **12,756 req/s** (`0.00%` errors, within noise/slightly ahead of the raw `Bun.serve()` harness calling `ValidationPipe` directly at `12,149 req/s`) with only `+0.009 ms` in-process p50 overhead.
4. **Sub-millisecond bootstrap & ~1.81M ops/s singleton DI:** Cold application startup (module graph scan + cycle/scope-leak validation + route compilation + lifecycle init) completes in **`0.3675 ms` p50** (`1,987 ops/s`), hot singleton resolution runs at **1,811,988 ops/s** (`0.0004 ms` p50), and full `Scope.REQUEST` container allocation/resolution/cleanup runs at **157,979 ops/s** (`0.0051 ms` p50).
5. **Cross-framework NestJS `v12.5.1` head-to-head:** In the isolated 8-target comparison ([`benchmarks/nestjs-comparison/RESULTS.md`](../benchmarks/nestjs-comparison/RESULTS.md)), these same optimizations put Bunest ahead of all NestJS adapters (`@nestjs/platform-node`, Fastify, Express) on **both Bun (`1.54x–3.25x`) and Node.js (`1.89x–10.29x`) across all 4 GET & POST workloads**, with `296.0 ms` cold start (`1.81x–5.20x` faster) and `55.9 MB` idle RSS.

---

## 6. Reproducing Locally

```bash
# Run full Bunest vs Raw Bun.serve() suite and regenerate benchmarks/RESULTS.md
bun run benchmarks/run.ts

# Quick smoke benchmark
bun run benchmarks/run.ts --quick

# Custom workload parameters
bun run benchmarks/run.ts --requests 5000 --warmup 500 --concurrency 64 --iterations 20000

# Run 8-target head-to-head comparison against upstream NestJS v12.5.1
cd benchmarks/nestjs-comparison && bun install && bun run bench
```

See [`benchmarks/README.md`](../benchmarks/README.md) and [`benchmarks/nestjs-comparison/README.md`](../benchmarks/nestjs-comparison/README.md) for script internals and workload definitions.
