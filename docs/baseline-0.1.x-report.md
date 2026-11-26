# Bunest `0.1.x` Baseline & Readiness Report

**Date:** 2026-11-26  
**Plan Reference:** `docs/ke-hoach-phat-trien-bunest.md` (Phase 1 Tickets 1–5 & Phase 2 Weeks 3–6)  
**Baseline Commit:** `790eb8786cd51ce1a382805031284406eb52989f`  
**Phase 1 Merged Commit:** `8297204616efbce83b67f6242bebfb6113b9dec2`  
**Phase 2 Merged Commits:** `2656677` (`docs/public-api-matrix.md`), `fbf4d54` (`.d.ts` emit & Dockerfile), `3ec57a3` (`verify:upgrade-pilots`)

---

## 1. Execution Environment

| Property | Value |
|---|---|
| OS | Microsoft Windows 11 Home Single Language (`10.0.26300`, Build `26300`) |
| Runtime | Bun `1.4.3` (target production/CI runtime: Linux + Bun `1.4.5`) |
| `docker` | Installed (`C:\Program Files\Docker\Docker\resources\bin\docker.exe`), daemon **not running** |
| `psql` | Installed (`psql (PostgreSQL) 18.6`), no local server on `:5432` |
| `redis-cli` | Not installed, no local server on `:6379` |

---

## 2. Verification Gates: Before vs. After

| Gate | Command | Baseline (`790eb87`) | Post-Merge (`main`) | Duration (Post-Merge) |
|---|---|---|---|---|
| 1 | `bun run typecheck` | PASS (0 errors) | **PASS** (0 errors) | 1.04s |
| 2 | `bun run build` | PASS (19 pkgs + apps) | **PASS** (19 pkgs + apps, 142 docs pages / 963 search sections) | 3.43s |
| 3 | `bun run ai:docs --check` | PASS | **PASS** (all generated AI docs up to date) | 0.98s |
| 4 | `bun run conformance:gate` | FAIL — 7001/7005 pass, 0 skip, **4 fail** | **7004/7005 pass**, 0 skip, **1 fail** (Windows-only `touch` ENOENT after template restore) | 52.46s |
| 5 | `bun run verify:release` | PASS (19/19 zero-dep, 0 runtime/DAG cycles) | **PASS** (19/19 zero-dep, 2/2 `node:*` adapters, 0 runtime/DAG cycles, 5 non-blocking type-only cycles, CLI smoke PASS) | 9.94s |
| 6 | `bun test` | FAIL — 8358 pass, 3 skip, **19 fail**, **3 unhandled errors** (883 files) | **8378 pass**, 3 skip (real Redis), **2 fail** (Windows-only `touch`/`openssl`), **0 unhandled errors** (884 files) | 71.98s |

---

## 3. P1 / P2 Bugs Discovered & Fixed

### P1 Fixes
1. **Runtime `NODE_ENV === "production"` constant-folding under `bun test` (10 test failures across 9 files, incl. conformance `devtools-integration.spec.ts`):**
   - Replaced static `process.env.NODE_ENV` checks with dynamic `Reflect.get(process.env, "NODE_ENV")` across 14 source sites in `core`, `graphql`, `mail`, `messaging`, `observability`, `orm`, `resilience`, `security`, and `workflows` (`eda073d`).
2. **Clean-install blocker — published `exports[*].bun` pointed to raw `./src/*.ts` across all 19 packages:**
   - Installing `@bunest/cli@0.1.0` outside the monorepo (with no `tsconfig.json`) crashed at import time because Bun transpiled `node_modules/@bunest/core/src/` with TC39 Stage 3 decorators instead of legacy decorators.
   - Added `withPublishableManifest()` (`scripts/publish-manifest.ts`) and wired it into `scripts/publish-packages.ts` and `scripts/verify-staging-registry.ts` to rewrite `exports[*].bun` -> `entry.import` during pack/publish and restore original bytes in `finally`, backed by `tests/packaging/publish-manifest.spec.ts` (`1b4b155`).
3. **Staging verifier (`scripts/verify-staging-registry.ts`) fixes:**
   - Fixed invalid `bunest new` flags, Windows-safe temp directory fallback, and non-destructive `bunfig.toml` appending (`1b4b155`).
4. **Conformance `CreateUsersDto` schematic mismatch (`resource.schematic.spec.ts:302`):**
   - Updated `packages/cli/src/templates/schematic.templates.ts` to emit `name!: string;` (`8f74d76`).
5. **Conformance `Application Schematic` regression caught on merge:**
   - Restored `import { BunestFactory, ValidationPipe } from "@bunest/core";` in `packages/cli/src/templates/project.templates.ts` so `tests/nestjs-conformance/ecosystem/cli/schematics/application.schematic.spec.ts:267` passes without modifying upstream conformance assertions.

### P2 Fixes
6. **TDZ circular-metadata transform idempotency (`unified-plugin-and-config.spec.ts:192`):**
   - Added idempotency guard (`try\s*\{\s*return\s+$`) in `packages/cli/src/plugins/bunest.plugin.ts` and `packages/orm/src/plugin/circular-safe.plugin.ts` (`8f74d76`).
7. **Missing `"./package.json"` export in 5 packages:**
   - Added `"./package.json": "./package.json"` to `@bunest/cli`, `@bunest/elasticsearch`, `@bunest/microservices`, `@bunest/swagger`, and `@bunest/testing` (`eda073d`).
8. **Root `bun test` unhandled errors in 3 examples (`auth-jwt-sqlite`, `distributed-worker`, `vscode-extension-showcase`):**
   - Scoped `registerBunestPlugin` in `scripts/bunest.preload.ts` to `examples/**` (`classMacros: false`) so both root `bun test` and per-example `--cwd` runs succeed (`eda073d`).
9. **Windows path normalization & ops polish:**
   - Updated `apps/vscode-bunest/test/raw-query-runner.spec.ts` to use cross-platform `resolve()`, tightened `examples/production-rest-postgres/deploy/Caddyfile` to `path /metrics /metrics/*`, and added `app.enableShutdownHooks()` to `examples/starter/src/main.ts` (`eda073d`).
10. **EN/VI documentation & quickstart alignment (Ticket 2):**
    - Aligned 11 EN/VI doc files (`apps/docs/content{,-vi}/ecosystem/{roadmap,packages}.md`, `overview/first-steps.md`, `docs/{architecture,benchmarks,nestjs-comparison,nestjs-migration,security}.md`) with the canonical 19-package `0.1.0 Production Preview` scope, historical consolidation milestones, and actual `bunest new` quickstart flow (`1d7b507`, `e79457c`, `ad0ea4b`).

---

## 4. Clean-Install Out-of-Monorepo Verification (Tickets 3 & 4)

All 19 `@bunest/*` tarballs (`0.1.0`, zero `workspace:*` leaks) were packed via `scripts/publish-packages.ts --pack=...` and installed from a local HTTP staging registry into an isolated temp directory outside the monorepo (`0` workspace symlinks, isolated `BUN_INSTALL_CACHE_DIR`):

- **Install `@bunest/cli@0.1.0`:** `1,144ms` (exit 0)
- **`bunest info` (empty dir, no `tsconfig.json`):** `111ms` (exit 0)
- **`bunest new clean-quickstart --skip-install`:** `151ms` (exit 0; 10 files + `bunest.json`, `preload.ts`, `bunfig.toml`)
- **`bun install` in clean app:** `5,236ms` (exit 0)
- **Initial scaffold checks:** `bun run typecheck` (`248ms`, 0 errors / 226 files), `bun test` (`124ms`, 1 pass), `bun run verify` (`467ms`, `VERIFY PASS`), `bun run build` (`80ms`, `dist/main.js` 1.1 MB)
- **Time-to-first-request (`GET /` -> `200 OK`):** `9.42s` end-to-end (~`6.5s` pure install -> scaffold -> start)
- **Codegen + DTO + Health probes:** `bunest g resource users --no-spec` (`147ms`), added `CreateUserDto` (`@bunest/validation/validator`), `/live`, `/ready`, and `test/users.spec.ts`:
  - `bun run typecheck`: `201ms` (0 errors / 233 files)
  - `bun test`: `147ms` (2 pass, 0 fail)
  - `bun run verify`: `522ms` (`VERIFY PASS`)
  - Real HTTP against `bun dist/main.js`: `GET /live` -> `200`, `GET /ready` -> `200`, `POST /users` (valid DTO) -> `201`, `POST /users` (invalid DTO + non-whitelisted field) -> `400` normalized Bunest validation envelope, `GET /users` -> `200`.

---

## 5. 19-Package Export Inventory & Ops Readiness Summary

- **Exports & ADR-017:** 19/19 packages at uniform `0.1.0`, **0 external runtime deps**, **0 broken subpath targets** across 87 export entries, valid DAG (`bun run verify:staging-plan` PASS), 19/19 include `README.md`, `publishConfig.access: "public"`, and `"./package.json"` export.
- **Health probes & shutdown (`examples/production-rest-postgres`):** `/live` is DB-independent (`200`); `/ready` pings `Bun.SQL` with timeout and transitions `200 -> 503 -> 200` on outage/recovery and `503` during `beginShutdown()`; `BunHttpAdapter.close()` drains in-flight requests with `enableShutdownHooks()` (`SIGINT`/`SIGTERM`).
- **ORM / Migrations / Rollback:** `BunSqlOrmDriver.transaction()` uses `Bun.SQL` `begin()`/`savepoint()` + `AsyncLocalStorage`; `synchronize: false`, additive migrations (`001` -> `002`), non-destructive `deploy/rollback.sh` (`<300s` gate), and `scripts/smoke-postgres.ts` ready for Linux staging.

---

## 6. Phase 2 Completions (`.d.ts`, Dockerfile, Local Soak/Drain, Public API Matrix, Upgrade & Pilots)

1. **[P1 #1 RESOLVED — `.d.ts` Declaration Emission & Strict TS Verification (`fbf4d54`)]**
   - Added `scripts/build-dts.ts` (wired into `bun run build` and `bun run build:dts`): emits **1,491 `.d.ts` files** into `packages/*/dist/` across all 19 packages in a single `tsc --emitDeclarationOnly` pass, verifies 0 internal `/src/` or `../packages/` path leaks, and verifies non-empty `.d.ts` artifacts for all 76 code export subpaths.
   - Updated `scripts/publish-manifest.ts` to rewrite top-level `types` and `exports[*].types` from `./src/*.ts` to `./dist/**/*.d.ts` with fallback safety, enforced by `scripts/verify-release.ts` and `tests/packaging/publish-manifest.spec.ts` (3/3 pass, 565 expects).
   - Verified clean out-of-monorepo packed tarballs with `tsc --noEmit --skipLibCheck false` importing all 19 `@bunest/*` packages: **PASS (exit 0)**.
2. **[P1 #2 RESOLVED — `examples/production-rest-postgres/Dockerfile` Frozen-Lockfile Workspace Fix (`fbf4d54`)]**
   - Added explicit `COPY` instructions for all 3 `apps/*/package.json` and 7 sibling `examples/*/package.json` workspace manifests prior to `bun install --frozen-lockfile`.
   - Verified builder-stage simulation in a clean temp directory: `bun install --frozen-lockfile` **PASS (exit 0)** and `bun run --cwd examples/production-rest-postgres build` **PASS (exit 0)**.
3. **[Weeks 3–4 — Local Operations & Infrastructure Verification (Windows 11, Bun `1.4.3`)]**
   - **Git for Windows `PATH` verification:** Prepending `C:\Program Files\Git\usr\bin` (`openssl.exe` 3.5.7, `touch.exe` 8.32, `bash.exe`) clears both Windows-only `ENOENT` failures (`metadata-transform.spec.ts` 8/8, `smtp-and-dkim.spec.ts` 6/6) -> **7,005/7,005 conformance PASS** (0 fail, 0 skip).
   - **HTTP Soak & RSS Stability (`examples/starter`, `/health`, `/brands`, `/shoes` over SQLite ORM, 20 concurrent workers, `21.76s`):**
     - `198,887` requests (`9,140.4 req/s`), `198,887` 2xx, `0` 4xx, **`0` 5xx (`0.0000%`)**, `0` network errors.
     - Latency: min `0.08ms`, p50 `1.79ms`, **p95 `3.14ms`**, p99 `4.35ms`, max `11.05ms`.
     - RSS (OS WorkingSet64): cold `59.61 MB`, post-warmup start `63.35 MB`, peak `91.59 MB`, end `69.82 MB` (`+6.47 MB` net delta; plateaued and GC'd down cleanly).
   - **`SIGTERM` Graceful Drain:** In-process `process.emit("SIGTERM")` against `BunestFactory.create` + `enableShutdownHooks()` with a 300ms `/slow` handler drained the in-flight request (`HTTP 200` at `303.4ms`), fired `onApplicationShutdown("SIGTERM")`, and rejected post-shutdown connections (note: Windows out-of-process `proc.kill("SIGTERM")` hard-terminates child processes).
   - **`examples/production-rest-postgres` checks:** Unit tests **4/4 PASS** (26 expects, `181ms`); `deploy/rollback.sh` syntax (`bash -n`) **PASS (exit 0)**.
4. **[Week 5 — Public API Matrix (`2656677`)]**
   - Created `docs/public-api-matrix.md` inventorying all 19 `@bunest/*` packages and all **95 declared `package.json#exports` keys** (19 root `.`, 57 named subpaths, 19 `./package.json`), aligned 1:1 with `docs/support-policy.md` stability tiers and `0.1.x -> 0.2.x -> 1.0` SemVer/deprecation policy.
   - Linked from `docs/support-policy.md` and lockstep EN/VI `apps/docs/content{,-vi}/ecosystem/roadmap.md` (`docs-engine.spec.ts` 9/9 pass, 0 broken links).
5. **[Weeks 5–6 — Automated Upgrade Path & Pilot A/B (`3ec57a3`)]**
   - Added `scripts/verify-upgrade-and-pilots.ts` (`bun run verify:upgrade-pilots`): runs end-to-end in an isolated temp dir outside the monorepo against packed `@bunest/*` tarballs over a local HTTP registry (`0` symlinks, `0` repo `package.json` mutations), **100% PASS** (`52.45s`):
     - **Pilot A (Greenfield REST API @ `0.1.0`):** `bunest new`, `UsersModule`, DTO validation (`201`/`400`), `/live` & `/ready` (`200`), 240-req burst (`240/240` 2xx, `0%` 5xx, p95 `9.71ms`, RSS `+0.87 MB`), `SIGTERM` in-flight drain (`HTTP 200`, exit `0`, `227.89ms`).
     - **Pilot B (NestJS-Migrated Module @ `0.1.0`):** `@UseGuards` (`401`/`200`), `ValidationPipe` (`400`), `@UseInterceptors`, `@Entity` + `CrudRepository` on file-backed SQLite with CRUD persistence across restart and clean failed-transaction rollback.
     - **Week 5 Upgrade (`0.1.0 -> 0.1.1-rc.0`):** Both Pilot A (p95 `7.64ms`, RSS `+0.90 MB`, `SIGTERM` drain `200`) and Pilot B (2 rows persisted across upgrade + restart, tx rollback clean) passed with zero regressions.

---

## 7. Remaining External-Infra & Human Sign-Off Items

Only external infrastructure and human sign-off items remain outside this local Windows workstation:

1. **Linux + Bun `1.4.5` CI Run:** Execute the full verification loop (`build`, `typecheck`, `ai:docs --check`, `verify:release`, `conformance:gate`, `bun test`) on Linux + Bun `1.4.5` (native POSIX `touch`/`openssl` and out-of-process `SIGTERM` drain).
2. **Live PostgreSQL 17 & Docker Daemon Staging Drill:** Start Docker / PG 17 (or run in Linux staging) to execute `docker build` on `examples/production-rest-postgres/Dockerfile`, `examples/production-rest-postgres/scripts/smoke-postgres.ts`, backup/restore verification, 2-hour dual-instance soak test (`p95 < 200ms`, `5xx < 0.1%`, stable RSS), and `<5m` rolling-upgrade/rollback drill.
3. **Human Pilot Sign-Off:** Collect external pilot team sign-off from real staging/production workloads before cutting `1.0`.
