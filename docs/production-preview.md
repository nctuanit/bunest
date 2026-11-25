# Bunest 0.1 — Production Preview (Linux REST API)

This document defines the supported scope, known limitations, operational runbooks, and release gates for **Bunest 0.1 Production Preview**.

---

## 1. Supported Scope (0.1 Production Preview)

| Dimension | Commitment |
| --- | --- |
| **Operating System** | Linux (`ubuntu-latest`, Alpine Linux containers) |
| **Runtime** | Bun `1.4.5` (pinned required CI check; `latest` tracked in compatibility matrix) |
| **Core Modules** | HTTP (`@bunest/core`), Dependency Injection, DTO Validation (`@bunest/validation`) |
| **Database** | PostgreSQL (`@bunest/orm` via native `Bun.SQL`), explicit migrations (`synchronize: false`) |
| **Operations** | Structured JSON logging with secret redaction, `/live` & `/ready` health probes, internal `/metrics`, graceful `SIGTERM` shutdown & request draining |
| **Reference App** | [`examples/production-rest-postgres`](../examples/production-rest-postgres) |

### Out of Scope for 0.1 Preview

- **Redis** (`@bunest/cache/redis`, `@bunest/jobs/redis`): optional branch; only claimed for production once verified against real Redis crash/lease-expiry/retry tests.
- **TCP transport, GraphQL, WebSockets, and non-PostgreSQL DB drivers** (MySQL, MariaDB, MongoDB, LibSQL, D1): functional in the monorepo, but **not** part of the 0.1 production preview commitment.
- **macOS & Windows**: supported for local development and tracked in CI compatibility jobs, but **not** covered by production runtime SLAs.

---

## 2. Known Limitations

- **Bun-only runtime (`>= 1.4.5`)**: Node.js and Deno are intentionally unsupported.
- **Legacy TypeScript decorators**: requires `experimentalDecorators: true` and `emitDecoratorMetadata: true`.
- **`verbatimModuleSyntax: true`**: DI classes, DTOs, and entities must use value imports; interfaces and type aliases must use `import type`.
- **Promise-based interceptors (no RxJS)**: `CallHandler.handle()` returns `Promise<T>`.
- **No `synchronize: true` in production**: schema changes must be applied via standalone `bun run migrate` before switching traffic.

---

## 3. Verification & Local Reproduction Commands

### Framework & CI Gates

```bash
bun install --frozen-lockfile
bun run typecheck
bun run build
bun test
bun run conformance:gate
bun run ai:docs --check
bun run verify:release
```

### Real PostgreSQL Production Smoke Suite

Tests real PostgreSQL persistence across process restart, DTO validation (`201`/`400`/`404`), transaction rollback atomicity, forward migrations (`001 -> 002`) with live data, DB outage/recovery (`/live` stays `200`, `/ready` transitions `200 -> 503 -> 200` without app restart), `pg_dump`/`psql` backup & restore, graceful `SIGTERM` exit, and log secret redaction:

```bash
DATABASE_ADMIN_URL=postgres://user:pass@127.0.0.1:5432/postgres \
  bun run smoke:postgres
```

### Staging Registry Clean-Install Verification

```bash
# Offline DAG & publish-order audit
bun run verify:staging-plan

# Clean out-of-monorepo install from a staging registry (e.g. Verdaccio)
bun run scripts/verify-staging-registry.ts \
  --registry=http://127.0.0.1:4873 \
  --publish \
  --version=0.1.0-rc.1
```

---

## 4. Deployment, Rolling Upgrade & Rollback Runbook

Reference artifacts live in [`examples/production-rest-postgres/`](../examples/production-rest-postgres/):
- [`Dockerfile`](../examples/production-rest-postgres/Dockerfile) — pinned `oven/bun:1.4.5-alpine`, multi-stage build, non-root `bun` user.
- [`deploy/docker-compose.yml`](../examples/production-rest-postgres/deploy/docker-compose.yml) — PostgreSQL 17, one-shot `migrate` job, 2 API instances (`api-1`, `api-2`), and Caddy reverse proxy.
- [`deploy/Caddyfile`](../examples/production-rest-postgres/deploy/Caddyfile) — automatic HTTPS, active `/ready` probing, 1 MiB body limit, upstream timeouts, and public `403` block on `/metrics`.
- [`deploy/rollback.sh`](../examples/production-rest-postgres/deploy/rollback.sh) — zero-downtime rolling rollback without destructive down migrations.

### Deploy Procedure

1. Build and tag an immutable image:
   ```bash
   docker build -f examples/production-rest-postgres/Dockerfile \
     --build-arg APP_VERSION=0.1.0-preview \
     -t bunest-prod-preview:0.1.0-preview .
   ```
2. Run migrations **before** switching traffic (additive, backward-compatible only):
   ```bash
   APP_IMAGE_TAG=0.1.0-preview \
     docker compose -f examples/production-rest-postgres/deploy/docker-compose.yml run --rm migrate
   ```
3. Roll `api-1`, wait for `/ready == 200`, then roll `api-2`.

### Rollback Procedure (`< 5 min` Gate)

Never run down migrations automatically during an incident rollback. Because migrations follow expand-and-contract (additive first, destructive cleanup in a later release), the previous image remains compatible with the new schema:

```bash
./examples/production-rest-postgres/deploy/rollback.sh <previous-image-tag>
```

---

## 5. Load & Soak Test Runbook

Run the reproducible load harness for at least **2 hours** on staging VPS hardware before promoting to public preview:

```bash
bun run --cwd examples/production-rest-postgres load \
  --url=https://staging.example.com \
  --duration=2h \
  --concurrency=20 \
  --metrics-token="$METRICS_TOKEN" \
  --output=load-report-2h.json
```

**Reference App Target Gates (Healthy System):**
- `p95 < 200 ms`
- `5xx < 0.1%`
- Stable RSS (no continuous monotonic growth across the 2h window)
- Rollback completes in `< 5 minutes`

Fault-injection measurements (PostgreSQL outage/recovery, rolling deploy drain) are recorded separately from the healthy steady-state numbers.

---

## 6. Release Go / No-Go Criteria

| Milestone | Do Not Proceed If |
| --- | --- |
| **Real-Data Pilot (5 business days)** | Linux required CI job is not green 3 consecutive times, or real PostgreSQL persistence, migration, and backup/restore checks have not passed. |
| **Public Production Preview** | Rollback rehearsal has not passed, unresolved data-loss or critical bugs remain, 2h soak gate is unmet, or clean install from staging registry fails without local workarounds. |
| **Expanding Support Scope** | A module or platform lacks dedicated integration & fault-injection tests. Support is declared per module, never inferred from NestJS conformance test counts. |

---

## 7. Security Vulnerability Reporting

Do **not** open public GitHub issues for security vulnerabilities. Follow the private disclosure process in [`SECURITY.md`](../SECURITY.md).
