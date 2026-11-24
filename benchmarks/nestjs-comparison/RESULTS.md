# Head-to-Head Benchmark Results: Bunest vs Real Upstream NestJS

> **Measured directly on real hardware** via `benchmarks/nestjs-comparison/src/runner.ts`.
> Every target runs as an isolated child process bound to `127.0.0.1:0` with identical routes, identical DTOs, identical `ValidationPipe` options, and an identical HTTP/1.1 keep-alive load generator. No synthetic or extrapolated figures.

## 1. Environment & Disclosure (Section 21 Compliance)

| Property                     | Value                                                                                                                                                                                                                                              |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Measured At (UTC)            | `2026-11-20T07:51:45.642Z`                                                                                                                                                                                                                         |
| Bun Runtime                  | `v1.4.3` (`c6da4a4d`)                                                                                                                                                                                                                              |
| Node.js Runtime              | `v22.23.3`                                                                                                                                                                                                                                         |
| OS / Arch                    | `win32 10.0.26300 (x64)`                                                                                                                                                                                                                           |
| CPU                          | `AMD Ryzen 7 5800H with Radeon Graphics` (16 logical cores)                                                                                                                                                                                        |
| Total RAM                    | `63.36 GiB`                                                                                                                                                                                                                                        |
| Bunest Packages              | `@bunest/core@0.1.0`, `@bunest/common@0.1.0`, `@bunest/http@0.1.0`, `@bunest/validation@0.1.0`                                                                                                                                                     |
| Upstream NestJS Packages     | `@nestjs/core@12.5.1`, `@nestjs/common@12.5.1`, `@nestjs/platform-node@12.5.1`, `@nestjs/platform-fastify@12.5.1`, `@nestjs/platform-express@12.5.1`                                                                                               |
| HTTP Adapters & Runtime Libs | `fastify@5.12.8`, `express@5.3.0`, `rxjs@7.8.2`, `reflect-metadata@0.2.2`                                                                                                                                                                          |
| Validation Libraries         | `class-validator@0.14.4`, `class-transformer@0.5.1` (exact same versions across all targets)                                                                                                                                                       |
| Route Count                  | **4 routes** per server (`GET /health`, `GET /users/:id`, `POST /users`, `POST /users/validated`)                                                                                                                                                  |
| POST JSON Payload            | **59 bytes** (`{"email":"alice@bunest.dev","name":"Alice Nguyen","age":28}`)                                                                                                                                                                       |
| HTTP Load Profile            | **4,000 requests/workload** × **3 isolated runs**, **500 warmup** requests before each measured window, concurrency **32**, HTTP/1.1 `keep-alive`                                                                                                  |
| Cold Startup Profile         | **5 isolated process spawns** per target (`spawn` → `create()` → `listen(0, "127.0.0.1")` → first `GET /health` `200 OK` → `close()`)                                                                                                              |
| Process Environment          | `NODE_ENV=production`, logging disabled (`logger: false`), no compression middleware, no helmet/CORS middleware                                                                                                                                    |
| ValidationPipe Config        | Identical `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, forbidUnknownValues: true })` on `POST /users/validated` (pre-flight verified: valid → `201`, invalid DTO → `400`, extra field → `400` on all 8 targets) |
| NestJS Build Artifact        | Pre-compiled with `tsc@5.9.3` (`module: CommonJS`, `target: ES2022`, `experimentalDecorators: true`, `emitDecoratorMetadata: true`) — zero `ts-node`/`tsx` runtime distortion on Node `v22.23.3` or Bun `v1.4.3`                                   |
| Process & Memory Isolation   | Each target runs in its own child process; RSS, Heap Used, and CPU time are queried directly from the isolated server process via stdin/stdout IPC (adding zero HTTP routes)                                                                       |

---

## 2. Headline HTTP Throughput Summary (Median of 3 Runs, req/s)

### Cross-Runtime Head-to-Head (Bunest on Bun vs NestJS on Bun & Node)

| Workload                                                  | Raw `Bun.serve` (Bun) | **Bunest (Bun)** | NestJS+Node (Bun) | NestJS+Fastify (Bun) | NestJS+Express (Bun) | NestJS+Node (Node) | NestJS+Fastify (Node) | NestJS+Express (Node) | Bunest vs NestJS+Node (Node) | Bunest vs NestJS+Fastify (Node) | Bunest vs NestJS+Express (Node) |
| --------------------------------------------------------- | --------------------: | ---------------: | ----------------: | -------------------: | -------------------: | -----------------: | --------------------: | --------------------: | ---------------------------: | ------------------------------: | ------------------------------: |
| 1. Static GET /health                                     |                46,356 |       **38,918** |            15,775 |               13,925 |               11,991 |              9,114 |                 8,439 |                 3,783 |                    **4.27x** |                       **4.61x** |                      **10.29x** |
| 2. Param GET /users/:id + DI                              |                44,425 |       **37,897** |            17,842 |               16,316 |               12,466 |             14,027 |                11,292 |                 4,357 |                    **2.70x** |                       **3.36x** |                       **8.70x** |
| 3. JSON POST /users (@Body, 59B)                          |                34,009 |       **25,916** |            13,667 |               12,158 |                9,463 |              9,058 |                 8,824 |                 3,911 |                    **2.86x** |                       **2.94x** |                       **6.63x** |
| 4. Validated POST /users/validated (DTO + ValidationPipe) |                15,639 |       **12,992** |             8,453 |                7,897 |                6,638 |              6,869 |                 6,747 |                 3,286 |                    **1.89x** |                       **1.93x** |                       **3.95x** |

### Same-Runtime Comparison on Bun `v1.4.3` (vs Raw `Bun.serve()` Baseline)

| Workload                                                  | Raw `Bun.serve` (req/s) | **Bunest (req/s)** | Bunest % of Raw | NestJS+Node on Bun | NestJS+Fastify on Bun | NestJS+Express on Bun | Bunest vs NestJS+Node (Bun) | Bunest vs NestJS+Fastify (Bun) | Bunest vs NestJS+Express (Bun) |
| --------------------------------------------------------- | ----------------------: | -----------------: | --------------: | -----------------: | --------------------: | --------------------: | --------------------------: | -----------------------------: | -----------------------------: |
| 1. Static GET /health                                     |                  46,356 |         **38,918** |           84.0% |             15,775 |                13,925 |                11,991 |                   **2.47x** |                      **2.79x** |                      **3.25x** |
| 2. Param GET /users/:id + DI                              |                  44,425 |         **37,897** |           85.3% |             17,842 |                16,316 |                12,466 |                   **2.12x** |                      **2.32x** |                      **3.04x** |
| 3. JSON POST /users (@Body, 59B)                          |                  34,009 |         **25,916** |           76.2% |             13,667 |                12,158 |                 9,463 |                   **1.90x** |                      **2.13x** |                      **2.74x** |
| 4. Validated POST /users/validated (DTO + ValidationPipe) |                  15,639 |         **12,992** |           83.1% |              8,453 |                 7,897 |                 6,638 |                   **1.54x** |                      **1.65x** |                      **1.96x** |

---

## 3. Detailed HTTP Workload Breakdown (Throughput, Latency, CPU, RSS, Errors)

Each table shows the **median run by throughput** across 3 independent isolated server runs, alongside the min–max throughput range and coefficient of variation (CV%) across all 3 runs.

### 1. Static GET /health

| Target                          | Median Throughput (req/s) | Run Range (min–max req/s) | CV (%) | p50 (ms) | p95 (ms) | p99 (ms) | Server CPU (ms / %) | Post RSS (MB) | Errors (%) |
| ------------------------------- | ------------------------: | ------------------------: | -----: | -------: | -------: | -------: | ------------------: | ------------: | ---------: |
| Raw Bun.serve() (Bun)           |                    46,356 |             41,837–48,392 |   6.0% |    0.659 |    1.042 |    1.509 |         78 ms (90%) |          49.3 |      0.00% |
| **Bunest (@bunest/core) (Bun)** |                **38,918** |             38,332–41,528 |   3.5% |    0.720 |    1.251 |    1.669 |         94 ms (91%) |          66.5 |      0.00% |
| NestJS + Platform Node (Bun)    |                    15,775 |             15,692–16,137 |   1.2% |    1.740 |    3.943 |    4.381 |       344 ms (136%) |         112.3 |      0.00% |
| NestJS + Fastify (Bun)          |                    13,925 |             12,630–14,118 |   4.9% |    1.990 |    3.945 |    4.626 |       453 ms (158%) |         117.0 |      0.00% |
| NestJS + Express (Bun)          |                    11,991 |             11,666–12,246 |   2.0% |    2.436 |    4.257 |    5.410 |       437 ms (131%) |         109.4 |      0.00% |
| NestJS + Platform Node (Node)   |                     9,114 |               9,102–9,443 |   1.7% |    3.384 |    5.589 |    6.216 |       703 ms (160%) |         100.0 |      0.00% |
| NestJS + Fastify (Node)         |                     8,439 |               8,366–8,535 |   0.8% |    3.781 |    5.119 |    6.259 |       718 ms (151%) |         101.0 |      0.00% |
| NestJS + Express (Node)         |                     3,783 |               3,688–3,832 |   1.6% |    8.031 |   15.657 |   26.191 |      1454 ms (138%) |         132.2 |      0.00% |

### 2. Param GET /users/:id + DI

| Target                          | Median Throughput (req/s) | Run Range (min–max req/s) | CV (%) | p50 (ms) | p95 (ms) | p99 (ms) | Server CPU (ms / %) | Post RSS (MB) | Errors (%) |
| ------------------------------- | ------------------------: | ------------------------: | -----: | -------: | -------: | -------: | ------------------: | ------------: | ---------: |
| Raw Bun.serve() (Bun)           |                    44,425 |             36,213–46,718 |  10.6% |    0.683 |    1.091 |    1.566 |        93 ms (103%) |          51.2 |      0.00% |
| **Bunest (@bunest/core) (Bun)** |                **37,897** |             36,466–39,132 |   2.9% |    0.762 |    1.318 |    1.698 |       109 ms (103%) |          73.1 |      0.00% |
| NestJS + Platform Node (Bun)    |                    17,842 |             17,288–19,174 |   4.4% |    1.651 |    2.615 |    3.530 |       391 ms (174%) |         110.7 |      0.00% |
| NestJS + Fastify (Bun)          |                    16,316 |             16,140–17,048 |   2.4% |    1.838 |    2.689 |    3.405 |       344 ms (140%) |         107.1 |      0.00% |
| NestJS + Express (Bun)          |                    12,466 |             11,617–12,895 |   4.3% |    2.392 |    3.369 |    4.264 |       547 ms (170%) |         108.2 |      0.00% |
| NestJS + Platform Node (Node)   |                    14,027 |             13,570–14,214 |   1.9% |    2.244 |    3.024 |    3.664 |       360 ms (126%) |         100.4 |      0.00% |
| NestJS + Fastify (Node)         |                    11,292 |             11,123–11,473 |   1.3% |    2.767 |    3.799 |    5.162 |       438 ms (124%) |         102.2 |      0.00% |
| NestJS + Express (Node)         |                     4,357 |               4,034–4,418 |   3.9% |    6.955 |   10.193 |   13.348 |      1157 ms (126%) |         170.7 |      0.00% |

### 3. JSON POST /users (@Body, 59B)

| Target                          | Median Throughput (req/s) | Run Range (min–max req/s) | CV (%) | p50 (ms) | p95 (ms) | p99 (ms) | Server CPU (ms / %) | Post RSS (MB) | Errors (%) |
| ------------------------------- | ------------------------: | ------------------------: | -----: | -------: | -------: | -------: | ------------------: | ------------: | ---------: |
| Raw Bun.serve() (Bun)           |                    34,009 |             31,575–35,138 |   4.4% |    0.876 |    1.346 |    1.722 |       125 ms (106%) |          52.1 |      0.00% |
| **Bunest (@bunest/core) (Bun)** |                **25,916** |             24,785–26,879 |   3.3% |    1.110 |    1.830 |    3.071 |       188 ms (122%) |          71.0 |      0.00% |
| NestJS + Platform Node (Bun)    |                    13,667 |             13,159–14,224 |   3.2% |    2.213 |    3.223 |    5.027 |       422 ms (144%) |         103.1 |      0.00% |
| NestJS + Fastify (Bun)          |                    12,158 |             11,436–12,386 |   3.4% |    2.452 |    3.600 |    4.883 |       467 ms (142%) |         104.7 |      0.00% |
| NestJS + Express (Bun)          |                     9,463 |               9,078–9,470 |   2.0% |    3.205 |    4.650 |    5.222 |       516 ms (122%) |         105.3 |      0.00% |
| NestJS + Platform Node (Node)   |                     9,058 |               8,576–9,437 |   3.9% |    3.480 |    4.580 |    5.173 |       671 ms (152%) |         100.8 |      0.00% |
| NestJS + Fastify (Node)         |                     8,824 |               8,810–8,916 |   0.5% |    3.558 |    4.778 |    5.742 |       624 ms (138%) |         102.8 |      0.00% |
| NestJS + Express (Node)         |                     3,911 |               3,812–3,913 |   1.2% |    7.981 |   10.212 |   11.841 |      1312 ms (128%) |         176.1 |      0.00% |

### 4. Validated POST /users/validated (DTO + ValidationPipe)

| Target                          | Median Throughput (req/s) | Run Range (min–max req/s) | CV (%) | p50 (ms) | p95 (ms) | p99 (ms) | Server CPU (ms / %) | Post RSS (MB) | Errors (%) |
| ------------------------------- | ------------------------: | ------------------------: | -----: | -------: | -------: | -------: | ------------------: | ------------: | ---------: |
| Raw Bun.serve() (Bun)           |                    15,639 |             14,282–15,833 |   4.5% |    1.798 |    3.207 |    4.368 |       390 ms (152%) |          75.7 |      0.00% |
| **Bunest (@bunest/core) (Bun)** |                **12,992** |             12,734–13,306 |   1.8% |    2.273 |    3.603 |    4.585 |       593 ms (193%) |          88.7 |      0.00% |
| NestJS + Platform Node (Bun)    |                     8,453 |               8,439–8,550 |   0.6% |    3.604 |    5.092 |    5.824 |       766 ms (162%) |         114.8 |      0.00% |
| NestJS + Fastify (Bun)          |                     7,897 |               6,299–7,933 |  10.3% |    3.853 |    5.508 |    6.434 |       780 ms (154%) |         119.2 |      0.00% |
| NestJS + Express (Bun)          |                     6,638 |               6,607–6,660 |   0.3% |    4.555 |    6.274 |    7.543 |      1062 ms (176%) |         111.5 |      0.00% |
| NestJS + Platform Node (Node)   |                     6,869 |               6,529–6,930 |   2.6% |    4.460 |    6.285 |    6.781 |       828 ms (142%) |         102.9 |      0.00% |
| NestJS + Fastify (Node)         |                     6,747 |               6,727–6,893 |   1.1% |    4.650 |    5.783 |    6.587 |       891 ms (150%) |         105.0 |      0.00% |
| NestJS + Express (Node)         |                     3,286 |               3,280–3,349 |   0.9% |    9.418 |   11.984 |   13.224 |      1515 ms (124%) |         178.4 |      0.00% |

---

## 4. Cold Startup Time (Workload 5 — Median of 5 Isolated Spawns)

Measures end-to-end wall-clock latency from spawning the server child process until the first live HTTP `GET /health` returns `200 OK` with `{"status":"ok"}`.

> **Fairness note:** NestJS targets run pre-compiled CommonJS (`dist/*.js` built via `tsc`), whereas Bunest and Raw `Bun.serve()` run directly from TypeScript source (`src/*.ts`) — meaning Bunest pays on-the-fly TypeScript transpilation on startup while NestJS does not.

| Target                          | Entrypoint                                | Median Cold Start (ms) |  Min–Max (ms) | All Samples (ms)                       |   Relative to Bunest | Idle RSS (MB) |
| ------------------------------- | ----------------------------------------- | ---------------------: | ------------: | -------------------------------------- | -------------------: | ------------: |
| Raw Bun.serve() (Bun)           | `src/server-raw-bun.ts (native TS)`       |                  167.2 |   163.5–174.6 | 167.9, 167.2, 166.3, 163.5, 174.6      |                0.56x |          38.3 |
| **Bunest (@bunest/core) (Bun)** | `src/server-bunest.ts (native TS)`        |              **296.0** |   293.6–321.7 | 294.7, 293.6, 296.5, 296.0, 321.7      | **1.00x (baseline)** |          55.1 |
| NestJS + Platform Node (Bun)    | `dist/server-nestjs-node.js (tsc CJS)`    |                  567.1 |   550.6–609.4 | 578.5, 609.4, 550.6, 557.5, 567.1      |                1.92x |          70.6 |
| NestJS + Fastify (Bun)          | `dist/server-nestjs-fastify.js (tsc CJS)` |                  617.9 |   603.5–644.1 | 625.3, 617.9, 644.1, 605.7, 603.5      |                2.09x |          72.8 |
| NestJS + Express (Bun)          | `dist/server-nestjs-express.js (tsc CJS)` |                  537.1 |   527.9–552.0 | 552.0, 527.9, 537.1, 529.7, 539.0      |                1.81x |          71.3 |
| NestJS + Platform Node (Node)   | `dist/server-nestjs-node.js (tsc CJS)`    |                 1433.6 | 1410.2–1454.8 | 1427.7, 1454.8, 1433.6, 1410.2, 1438.1 |                4.84x |          85.9 |
| NestJS + Fastify (Node)         | `dist/server-nestjs-fastify.js (tsc CJS)` |                 1539.1 | 1534.1–1572.9 | 1539.1, 1537.1, 1534.1, 1572.9, 1560.0 |                5.20x |          91.0 |
| NestJS + Express (Node)         | `dist/server-nestjs-express.js (tsc CJS)` |                 1406.1 | 1392.6–1421.0 | 1400.2, 1406.1, 1421.0, 1392.6, 1410.6 |                4.75x |          85.7 |

---

## 5. Isolated Server Memory Footprint (Workload 6a — RSS & Heap)

Idle RSS is sampled immediately after `listen(0)` before any HTTP traffic. Peak Loaded RSS is the maximum post-workload RSS observed across all 4 workloads and all 3 runs on the actual server child process.

| Target                          | Idle RSS (MB) | Peak Loaded RSS (MB) | RSS Delta Under Load (MB) | Idle Heap Used (MB) | Peak Heap Used (MB) |
| ------------------------------- | ------------: | -------------------: | ------------------------: | ------------------: | ------------------: |
| Raw Bun.serve() (Bun)           |          38.4 |                 75.7 |                     +37.3 |                 3.5 |                 8.8 |
| **Bunest (@bunest/core) (Bun)** |          55.9 |                 88.7 |                     +32.7 |                 6.2 |                15.5 |
| NestJS + Platform Node (Bun)    |          70.6 |                115.8 |                     +45.2 |                10.8 |                13.8 |
| NestJS + Fastify (Bun)          |          72.9 |                121.2 |                     +48.3 |                 9.7 |                15.0 |
| NestJS + Express (Bun)          |          71.5 |                111.5 |                     +40.0 |                 9.8 |                14.4 |
| NestJS + Platform Node (Node)   |          86.7 |                103.1 |                     +16.5 |                29.2 |                37.0 |
| NestJS + Fastify (Node)         |          90.9 |                106.1 |                     +15.2 |                35.6 |                38.4 |
| NestJS + Express (Node)         |          85.8 |                178.4 |                     +92.6 |                30.0 |                99.1 |

---

## 6. Dependency & Disk Footprint (Workload 6b)

Computed by traversing the exact production dependency closure (`dependencies` + required `peerDependencies`, excluding `devDependencies` such as `typescript` and `@types/*`). For `@bunest/*` workspace packages, test directories are excluded to match published npm package contents (`"files": ["dist", "src", "README.md"]`).

### Full Stack (Including `class-validator` + `class-transformer` + `reflect-metadata`)

| Stack (Including Validation Libraries) | Total Packages (Direct + Transitive) | External npm Packages | Disk Footprint (MB) |
| -------------------------------------- | -----------------------------------: | --------------------: | ------------------: |
| **Bunest (@bunest/core + validation)** |                               **10** |                 **6** |           **17.74** |
| NestJS + Platform Node (+ validation)  |                                   98 |                    98 |               26.21 |
| NestJS + Fastify (+ validation)        |                                   84 |                    84 |               32.82 |
| NestJS + Express (+ validation)        |                                  103 |                   103 |               25.69 |

### Core Framework + HTTP Adapter Only (Excluding `class-validator` / `class-transformer`)

| Stack (Core Framework + HTTP Adapter Only, Excl. Validation Libs) | Total Packages (Direct + Transitive) | External npm Packages | Disk Footprint (MB) |
| ----------------------------------------------------------------- | -----------------------------------: | --------------------: | ------------------: |
| **Bunest (core HTTP + DI, excl. validation libs)**                |                                **4** |                 **1** |            **1.27** |
| NestJS + Platform Node (excl. validation libs)                    |                                   93 |                    93 |                9.84 |
| NestJS + Fastify (excl. validation libs)                          |                                   79 |                    79 |               16.45 |
| NestJS + Express (excl. validation libs)                          |                                   98 |                    98 |                9.33 |

> **Dependency breakdown note:** The shared `class-validator` + `class-transformer` subtree (`validator`, `libphonenumber-js`, `@types/validator`) accounts for **5 npm packages and ~16.37 MB** across every stack above.

---

## 7. Key Takeaways & Fairness Notes

1. **Same-codebase, zero-distortion methodology:** All 8 targets passed automated pre-flight semantic equivalence checks before benchmarking (`GET /health` → `200`, `GET /users/42` → `200`, `POST /users` → `201`, valid DTO → `201`, invalid DTO → `400`, non-whitelisted property → `400`), and all recorded **0.00% error rate**.
2. **Native `Bun.serve()` vs Node-compatibility HTTP adapters:** Even when upstream NestJS runs on Bun `v1.4.3` — including NestJS v12's zero-framework `@nestjs/platform-node` adapter — Express, Fastify, and `NodeAdapter` all route traffic through Node `http.Server` compatibility layers, whereas Bunest compiles `@Controller()` handlers directly onto Bun's native `Bun.serve()` routes.
3. **Validation workload & POST body parsing:** On `POST /users/validated`, `class-transformer` (`plainToInstance`) + `class-validator` (`validate`) dominate per-request CPU time across every target (including raw `Bun.serve()`), naturally compressing the relative spread compared to lightweight `GET` routes; with `Content-Length` fast-path `req.text()` parsing, 1-pass prototype-pollution checks (`BODY_SANITIZED_SYMBOL`), and zero-`Headers` `Response.json()` serialization, Bunest retains high relative efficiency against raw `Bun.serve()` and outpaces all NestJS adapters on both Bun and Node across all 4 workloads.
4. **Loopback client-in-same-machine caveat:** The Bun load generator and the target server share the same 8-core / 16-thread Windows machine over `127.0.0.1` loopback. Absolute req/s figures reflect single-machine loopback conditions; relative comparisons remain fair because every target faces the exact same client and OS network stack.

## 8. Reproduction

```bash
cd benchmarks/nestjs-comparison
bun install
bun run bench
```

Quick verification or smoke test:

```bash
bun run verify       # Verify all 8 targets pass identical functional & ValidationPipe assertions
bun run bench:quick  # Fast 1-run smoke benchmark
```
