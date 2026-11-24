# Bunest Benchmark Results

> **Measured automatically on real hardware** via `bun run benchmarks/run.ts`.
> No synthetic or extrapolated claims — every figure below was recorded directly on this machine.

## Environment & Configuration

| Property | Value |
|---|---|
| Measured At (UTC) | `2026-11-22T17:50:56.513Z` |
| Bun Runtime | `v1.4.5` (`a7733435`) |
| OS / Arch | `darwin 25.5.0 (arm64)` |
| CPU | `Apple M4` (10 logical cores) |
| Total RAM | `16.00 GiB` |
| Package Versions | `@bunest/core@0.1.0`, `class-validator@0.14.4`, `class-transformer@0.5.1` |
| Live HTTP Config | 4,000 requests/workload, 400 warmup, concurrency 32, HTTP/1.1 `keep-alive`, POST JSON payload 59 bytes, logging disabled |
| In-Process Dispatch Config | 10,000 iterations/workload, 1,000 warmup, concurrency 1 (isolates framework routing/pipeline/DI overhead from loopback TCP) |
| DI Microbench Config | 10,000 hot ops, 50 cold bootstraps |

## 1. Live Loopback HTTP (`Bun.serve({ port: 0 })`, Concurrency 32)

| Workload | Framework | Throughput (req/s) | p50 (ms) | p95 (ms) | p99 (ms) | RSS (MB) | Errors (%) |
|---|---|---:|---:|---:|---:|---:|---:|
| 1. Static GET /health | Bun.serve (raw) | 139,978 | 0.227 | 0.316 | 0.563 | 35.2 | 0.00% |
| 1. Static GET /health | Bunest | 156,094 | 0.154 | 0.296 | 0.321 | 38.3 | 0.00% |
| 2. Param GET /users/:id + DI | Bun.serve (raw) | 158,908 | 0.154 | 0.291 | 0.373 | 38.5 | 0.00% |
| 2. Param GET /users/:id + DI | Bunest | 151,968 | 0.165 | 0.306 | 0.409 | 38.6 | 0.00% |
| 3. JSON POST /users (@Body) | Bun.serve (raw) | 125,851 | 0.191 | 0.382 | 0.566 | 40.6 | 0.00% |
| 3. JSON POST /users (@Body) | Bunest | 109,714 | 0.223 | 0.432 | 0.751 | 42.7 | 0.00% |
| 4. Validated POST /users/validated (DTO) | Bun.serve (raw) | 95,492 | 0.259 | 0.530 | 0.822 | 50.4 | 0.00% |
| 4. Validated POST /users/validated (DTO) | Bunest | 93,508 | 0.274 | 0.537 | 0.781 | 52.1 | 0.00% |

### Live HTTP Overhead vs Raw `Bun.serve()`

| Workload | Raw `Bun.serve` (req/s) | Bunest (req/s) | Relative Throughput | p50 Overhead (ms) | p99 Overhead (ms) |
|---|---:|---:|---:|---:|---:|
| 1. Static GET /health | 139,978 | 156,094 | 111.5% | -0.073 | -0.242 |
| 2. Param GET /users/:id + DI | 158,908 | 151,968 | 95.6% | +0.011 | +0.036 |
| 3. JSON POST /users (@Body) | 125,851 | 109,714 | 87.2% | +0.032 | +0.185 |
| 4. Validated POST /users/validated (DTO) | 95,492 | 93,508 | 97.9% | +0.014 | -0.042 |

## 2. In-Process `fetch()` Dispatch Microbenchmark (10,000 ops)

Separates Bunest's compiled route matching, parameter extraction, DI resolution, and serialization cost from OS loopback socket overhead:

| Workload | Framework | Throughput (req/s) | p50 (ms) | p95 (ms) | p99 (ms) | RSS (MB) | Errors (%) |
|---|---|---:|---:|---:|---:|---:|---:|
| 1. Static GET /health | Bun.serve (raw) | 1,867,806 | 0.000 | 0.001 | 0.003 | 53.9 | 0.00% |
| 1. Static GET /health | Bunest | 1,088,895 | 0.001 | 0.001 | 0.004 | 57.2 | 0.00% |
| 2. Param GET /users/:id + DI | Bun.serve (raw) | 1,863,369 | 0.000 | 0.001 | 0.003 | 57.8 | 0.00% |
| 2. Param GET /users/:id + DI | Bunest | 934,278 | 0.001 | 0.001 | 0.004 | 60.2 | 0.00% |
| 3. JSON POST /users (@Body) | Bun.serve (raw) | 1,236,228 | 0.001 | 0.001 | 0.004 | 60.5 | 0.00% |
| 3. JSON POST /users (@Body) | Bunest | 438,807 | 0.002 | 0.003 | 0.007 | 63.4 | 0.00% |
| 4. Validated POST /users/validated (DTO) | Bun.serve (raw) | 501,783 | 0.002 | 0.002 | 0.007 | 68.2 | 0.00% |
| 4. Validated POST /users/validated (DTO) | Bunest | 314,175 | 0.003 | 0.004 | 0.007 | 69.6 | 0.00% |

### In-Process Overhead vs Raw Handler

| Workload | Raw `Bun.serve` (req/s) | Bunest (req/s) | Relative Throughput | p50 Overhead (ms) | p99 Overhead (ms) |
|---|---:|---:|---:|---:|---:|
| 1. Static GET /health | 1,867,806 | 1,088,895 | 58.3% | +0.000 | +0.001 |
| 2. Param GET /users/:id + DI | 1,863,369 | 934,278 | 50.1% | +0.000 | +0.001 |
| 3. JSON POST /users (@Body) | 1,236,228 | 438,807 | 35.5% | +0.001 | +0.003 |
| 4. Validated POST /users/validated (DTO) | 501,783 | 314,175 | 62.6% | +0.001 | +0.001 |

## 3. DI Container & Bootstrap Microbenchmarks

| Operation | Iterations | Throughput (ops/s) | p50 (ms) | p95 (ms) | p99 (ms) | RSS (MB) |
|---|---:|---:|---:|---:|---:|---:|
| Cold bootstrap (scan + DI + route compile + init) | 50 | 6,801 | 0.1145 | 0.3423 | 0.5108 | 74.0 |
| Hot singleton DI lookup (app.get) | 10,000 | 5,259,581 | 0.0001 | 0.0003 | 0.0005 | 74.5 |
| Hot transient DI resolve (app.resolve) | 10,000 | 413,487 | 0.0017 | 0.0029 | 0.0049 | 82.8 |
| Request-scoped DI lifecycle (create + resolve + destroy) | 10,000 | 580,302 | 0.0013 | 0.0020 | 0.0035 | 84.0 |

## Reproduction

```bash
bun run benchmarks/run.ts
```

Optional flags: `--requests <n>`, `--warmup <n>`, `--concurrency <n>`, `--iterations <n>`.
