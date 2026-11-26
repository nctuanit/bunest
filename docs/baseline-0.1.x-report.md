# Bunest `0.1.x` Baseline & Readiness Report

**Date:** 2026-11-26  
**Plan Reference:** `docs/ke-hoach-phat-trien-bunest.md` (Tickets 1–5)  
**Baseline Commit:** `790eb8786cd51ce1a382805031284406eb52989f`  
**Post-Merge Commit (before final report):** `8382abba07da7cc1e85d30ab92442b5b406a57fa` (+ conformance template restore commit on `main`)

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

## 6. Remaining Items for Linux Staging & Release Readiness

1. **[P1 — Packaging / Strict TS]** **Emit `.d.ts` declarations into `dist/`** across all 19 packages (currently `"types"` points to raw `./src/*.ts`; works for Bun + `skipLibCheck: true` + `moduleResolution: "bundler"`, but should emit `.d.ts` before `1.0` / strict TS consumers).
2. **[P1 — Docker / CI]** **Verify `examples/production-rest-postgres/Dockerfile`** on Linux CI with `bun install --frozen-lockfile` (root `package.json` declares `workspaces: ["packages/*", "apps/*", "examples/*"]` while Dockerfile copies only `packages/` and `examples/production-rest-postgres/`).
3. **[P2 — Linux Bun `1.4.5` CI Baseline]** Run full `bun run conformance:gate` (confirming 7,005/7,005, 0 skip, 0 fail) and `bun test` on Linux + Bun `1.4.5` to clear the 2 Windows-host-only `ENOENT` failures (`touch` in `metadata-transform.spec.ts:102`, `openssl` in `smtp-and-dkim.spec.ts:498`).
4. **[Weeks 3–4 — Staging Operations]** Execute live PostgreSQL 17 smoke (`scripts/smoke-postgres.ts`), backup/restore verification, 2-hour dual-instance soak test (`p95 < 200ms`, `5xx < 0.1%`, stable RSS), and `<5m` rolling-upgrade/rollback drill.
5. **[Weeks 5–6 — Pilot & Upgrade]** Run the two external pilot apps (greenfield API + NestJS module migration) and verify `0.1.0 -> 0.1.x` upgrade on the clean-installed app.
