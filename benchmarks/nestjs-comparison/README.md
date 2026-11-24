# Head-to-Head Benchmark: Bunest vs Real Upstream NestJS

Self-contained, isolated benchmark suite comparing **Bunest** (`@bunest/core`) directly against **real upstream NestJS v12** (`@nestjs/core`, `@nestjs/platform-node`, `@nestjs/platform-fastify`, `@nestjs/platform-express`) across both **Bun** and **Node.js**, plus a raw **`Bun.serve()`** baseline.

> **Strict isolation:** This directory has its own `package.json` (`"private": true`), `tsconfig.json`, `tsconfig.node.json`, and `.gitignore`. It is intentionally outside the root Bunest workspace (`packages/*`, `apps/*`, `examples/*`) so upstream NestJS dependencies never pollute the Bunest monorepo or root `bun.lock`.

## Targets Compared (8 Configurations)

| #   | Target                      | Runtime | HTTP Layer                                            | Entrypoint                      |
| --- | --------------------------- | ------- | ----------------------------------------------------- | ------------------------------- |
| A   | **Raw `Bun.serve()`**       | Bun     | Native `Bun.serve({ routes })`                        | `src/server-raw-bun.ts`         |
| B   | **Bunest (`@bunest/core`)** | Bun     | Native `Bun.serve()` via compiled Bunest routes       | `src/server-bunest.ts`          |
| C   | **NestJS + Platform Node**  | Bun     | `@nestjs/platform-node` (`node:http` + `find-my-way`) | `dist/server-nestjs-node.js`    |
| D   | **NestJS + Fastify**        | Bun     | `@nestjs/platform-fastify` + `fastify`                | `dist/server-nestjs-fastify.js` |
| E   | **NestJS + Express**        | Bun     | `@nestjs/platform-express` + `express`                | `dist/server-nestjs-express.js` |
| F   | **NestJS + Platform Node**  | Node.js | `@nestjs/platform-node` (`node:http` + `find-my-way`) | `dist/server-nestjs-node.js`    |
| G   | **NestJS + Fastify**        | Node.js | `@nestjs/platform-fastify` + `fastify`                | `dist/server-nestjs-fastify.js` |
| H   | **NestJS + Express**        | Node.js | `@nestjs/platform-express` + `express`                | `dist/server-nestjs-express.js` |

## Workloads Measured (6 Dimensions)

1. **Workload 1 — Static `GET /health`:** Returns `200 OK` with `{"status":"ok"}`. Measures minimal routing + JSON serialization overhead.
2. **Workload 2 — Parameterized `GET /users/:id` + DI:** Extracts `:id` via `@Param("id")` and queries a constructor-injected singleton `UsersService.findOne(id)`.
3. **Workload 3 — JSON `POST /users` (`@Body()`):** Parses a 59-byte JSON payload (`{"email":"alice@bunest.dev","name":"Alice Nguyen","age":28}`) via `@Body()` and returns `201 Created`.
4. **Workload 4 — Validated `POST /users/validated` (DTO + `ValidationPipe`):** Parses the same 59-byte JSON payload and validates `CreateUserDto` (`@IsEmail()`, `@IsString()`, `@MinLength(3)`, `@IsInt()`, `@Min(18)`) using identical `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, forbidUnknownValues: true })` backed by the exact same `class-validator` & `class-transformer` versions on every target.
5. **Workload 5 — Cold Startup Time:** Median of 5 isolated child-process spawns per target (`spawn` → `create()` → `listen(0, "127.0.0.1")` → first live `GET /health` `200 OK` → `close()`).
6. **Workload 6 — Memory & Dependency Footprint:**
   - **Process RSS & Heap:** Idle RSS right after `listen(0)` and Peak Loaded RSS across all HTTP workloads, queried directly from each isolated server child process via stdin/stdout IPC (adding zero HTTP routes).
   - **Dependency Closure:** Exact production dependency count (direct + transitive) and disk size (MB) for Bunest vs NestJS+Node vs NestJS+Fastify vs NestJS+Express (both with and without validation libraries).

## Fairness & Anti-Distortion Guarantees

- **Zero `ts-node`/`tsx` distortion on Node.js:** All NestJS targets are pre-compiled with `tsc` (`module: CommonJS`, `target: ES2022`, `experimentalDecorators: true`, `emitDecoratorMetadata: true`) into `dist/` before benchmarking, so Node.js (and Bun for NestJS) executes clean production JavaScript.
- **Identical environment & config:** Every target runs with `NODE_ENV=production`, logging disabled (`logger: false`), no compression middleware, no extra security/CORS plugins, and binds `127.0.0.1:0` (ephemeral port).
- **Pre-flight semantic equivalence check:** Before any timing starts, `src/runner.ts` spawns every target and asserts:
  - `GET /health` → `200` `{"status":"ok"}`
  - `GET /users/42` → `200` identical user JSON
  - `POST /users` (valid 59B JSON) → `201` identical created user JSON
  - `POST /users/validated` (valid 59B JSON) → `201`
  - `POST /users/validated` (invalid email/short name/underage) → `400`
  - `POST /users/validated` (extra non-whitelisted property) → `400`
- **Process isolation:** Each target runs in its own OS child process per run, preventing shared-event-loop interference or cross-framework memory contamination.
- **Repeatable multi-run statistics:** Default profile executes 3 independent full runs × 4,000 measured requests (after 500 warmup requests) at concurrency 32 with HTTP/1.1 `keep-alive`, reporting median throughput, min–max range, CV%, p50/p95/p99 latency, server CPU time, RSS, and error rate (`0.00%`).

## Reproduction

```bash
cd benchmarks/nestjs-comparison
bun install
bun run bench
```

### Optional Commands & Flags

```bash
# Verify functional & ValidationPipe equivalence across all 8 targets
bun run verify

# Fast 1-run smoke test
bun run bench:quick

# Custom run parameters
bun run build:node
bun run src/runner.ts --runs 3 --requests 4000 --warmup 500 --concurrency 32 --cold-runs 5
```

Latest verified results are recorded in [`RESULTS.md`](./RESULTS.md).
