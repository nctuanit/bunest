# Bunest Benchmark Results

> **Measured automatically on real hardware** via `bun run benchmarks/run.ts`.
> No synthetic or extrapolated claims — every figure below was recorded directly on this machine.

## Environment & Configuration

| Property | Value |
|---|---|
| Measured At (UTC) | `2026-11-20T16:37:18.127Z` |
| Bun Runtime | `v1.4.3` (`c6da4a4d`) |
| OS / Arch | `win32 10.0.26300 (x64)` |
| CPU | `AMD Ryzen 7 5800H with Radeon Graphics` (16 logical cores) |
| Total RAM | `63.36 GiB` |
| Package Versions | `@bunest/core@0.1.0`, `class-validator@0.14.4`, `class-transformer@0.5.1` |
| Live HTTP Config | 4,000 requests/workload, 400 warmup, concurrency 32, HTTP/1.1 `keep-alive`, POST JSON payload 59 bytes, logging disabled |
| In-Process Dispatch Config | 10,000 iterations/workload, 1,000 warmup, concurrency 1 (isolates framework routing/pipeline/DI overhead from loopback TCP) |
| DI Microbench Config | 10,000 hot ops, 50 cold bootstraps |

## 1. Live Loopback HTTP (`Bun.serve({ port: 0 })`, Concurrency 32)

| Workload | Framework | Throughput (req/s) | p50 (ms) | p95 (ms) | p99 (ms) | RSS (MB) | Errors (%) |
|---|---|---:|---:|---:|---:|---:|---:|
| 1. Static GET /health | Bun.serve (raw) | 22,863 | 1.365 | 1.902 | 2.925 | 66.0 | 0.00% |
| 1. Static GET /health | Bunest | 21,299 | 1.272 | 2.254 | 4.320 | 66.0 | 0.00% |
| 2. Param GET /users/:id + DI | Bun.serve (raw) | 18,290 | 1.482 | 2.601 | 15.124 | 63.9 | 0.00% |
| 2. Param GET /users/:id + DI | Bunest | 18,119 | 1.700 | 2.376 | 3.801 | 67.2 | 0.00% |
| 3. JSON POST /users (@Body) | Bun.serve (raw) | 15,666 | 1.903 | 3.144 | 5.299 | 66.4 | 0.00% |
| 3. JSON POST /users (@Body) | Bunest | 12,458 | 2.462 | 3.867 | 4.914 | 69.3 | 0.00% |
| 4. Validated POST /users/validated (DTO) | Bun.serve (raw) | 6,795 | 4.356 | 5.994 | 15.971 | 86.0 | 0.00% |
| 4. Validated POST /users/validated (DTO) | Bunest | 7,182 | 4.156 | 5.973 | 18.956 | 85.9 | 0.00% |

### Live HTTP Overhead vs Raw `Bun.serve()`

| Workload | Raw `Bun.serve` (req/s) | Bunest (req/s) | Relative Throughput | p50 Overhead (ms) | p99 Overhead (ms) |
|---|---:|---:|---:|---:|---:|
| 1. Static GET /health | 22,863 | 21,299 | 93.2% | -0.093 | +1.394 |
| 2. Param GET /users/:id + DI | 18,290 | 18,119 | 99.1% | +0.218 | -11.324 |
| 3. JSON POST /users (@Body) | 15,666 | 12,458 | 79.5% | +0.558 | -0.385 |
| 4. Validated POST /users/validated (DTO) | 6,795 | 7,182 | 105.7% | -0.201 | +2.985 |

## 2. In-Process `fetch()` Dispatch Microbenchmark (10,000 ops)

Separates Bunest's compiled route matching, parameter extraction, DI resolution, and serialization cost from OS loopback socket overhead:

| Workload | Framework | Throughput (req/s) | p50 (ms) | p95 (ms) | p99 (ms) | RSS (MB) | Errors (%) |
|---|---|---:|---:|---:|---:|---:|---:|
| 1. Static GET /health | Bun.serve (raw) | 299,164 | 0.003 | 0.008 | 0.014 | 94.1 | 0.00% |
| 1. Static GET /health | Bunest | 221,325 | 0.003 | 0.008 | 0.023 | 97.5 | 0.00% |
| 2. Param GET /users/:id + DI | Bun.serve (raw) | 294,501 | 0.003 | 0.005 | 0.018 | 98.2 | 0.00% |
| 2. Param GET /users/:id + DI | Bunest | 124,164 | 0.005 | 0.010 | 0.040 | 100.5 | 0.00% |
| 3. JSON POST /users (@Body) | Bun.serve (raw) | 228,768 | 0.003 | 0.006 | 0.024 | 101.2 | 0.00% |
| 3. JSON POST /users (@Body) | Bunest | 20,801 | 0.011 | 0.037 | 1.219 | 108.0 | 0.00% |
| 4. Validated POST /users/validated (DTO) | Bun.serve (raw) | 30,169 | 0.021 | 0.046 | 0.090 | 126.6 | 0.00% |
| 4. Validated POST /users/validated (DTO) | Bunest | 10,847 | 0.031 | 0.081 | 1.676 | 128.7 | 0.00% |

### In-Process Overhead vs Raw Handler

| Workload | Raw `Bun.serve` (req/s) | Bunest (req/s) | Relative Throughput | p50 Overhead (ms) | p99 Overhead (ms) |
|---|---:|---:|---:|---:|---:|
| 1. Static GET /health | 299,164 | 221,325 | 74.0% | +0.001 | +0.009 |
| 2. Param GET /users/:id + DI | 294,501 | 124,164 | 42.2% | +0.002 | +0.021 |
| 3. JSON POST /users (@Body) | 228,768 | 20,801 | 9.1% | +0.007 | +1.195 |
| 4. Validated POST /users/validated (DTO) | 30,169 | 10,847 | 36.0% | +0.010 | +1.586 |

## 3. DI Container & Bootstrap Microbenchmarks

| Operation | Iterations | Throughput (ops/s) | p50 (ms) | p95 (ms) | p99 (ms) | RSS (MB) |
|---|---:|---:|---:|---:|---:|---:|
| Cold bootstrap (scan + DI + route compile + init) | 50 | 1,235 | 0.5367 | 1.5730 | 5.3485 | 134.4 |
| Hot singleton DI lookup (app.get) | 10,000 | 1,273,869 | 0.0005 | 0.0010 | 0.0021 | 138.6 |
| Hot transient DI resolve (app.resolve) | 10,000 | 54,718 | 0.0138 | 0.0263 | 0.0443 | 154.6 |
| Request-scoped DI lifecycle (create + resolve + destroy) | 10,000 | 91,574 | 0.0077 | 0.0181 | 0.0272 | 151.1 |

## Reproduction

```bash
bun run benchmarks/run.ts
```

Optional flags: `--requests <n>`, `--warmup <n>`, `--concurrency <n>`, `--iterations <n>`.
