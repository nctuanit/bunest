# Bunest Support, Versioning & Stability Policy

This document defines Bunest's Semantic Versioning commitment, Bun runtime compatibility policy, and per-module stability tiers.

---

## 1. Semantic Versioning (`SemVer`)

Bunest follows [Semantic Versioning 2.0.0](https://semver.org/):

- **`0.x.y` (Pre-1.0 / Production Preview)**:
  - Patch releases (`0.1.x`) contain bug fixes, security patches, and backward-compatible improvements only.
  - Minor releases (`0.2.0`, `0.3.0`, ...) may introduce breaking changes, always documented in [`CHANGELOG.md`](../CHANGELOG.md) with migration notes and at least one deprecation cycle where practical.
- **`1.0.0+` (General Availability)**:
  - Public APIs exported via `package.json#exports` are strictly backward-compatible within a major version.
  - Breaking changes occur only in major versions (`2.0.0`, ...) with codemods or migration guides.
  - Deprecated APIs remain functional for at least one minor release (or 6 months on LTS lines) before removal.

All 19 `@bunest/*` workspace packages are **lockstep-versioned** (every release publishes all 19 packages under the same version number).

---

## 2. Bun Runtime Support Matrix

Bunest is a **Bun-native** framework (`ADR-017`) and intentionally does not target Node.js or Deno.

| Bunest Line | Minimum Bun | Pinned CI Runtime | Compatibility Matrix |
| --- | --- | --- | --- |
| **`0.1.x`** | `>= 1.4.5` | `1.4.5` (Linux `ubuntu-latest`, required) | `latest` on Linux, macOS, Windows |

- **Pinned CI gate**: Every PR and release is gated on Linux + Bun `1.4.5`.
- **Forward tracking**: Bun `latest` is continuously tested in CI so upstream Bun changes are caught early.
- **Bumping minimum Bun version**: Raising `engines.bun` requires at least a minor release in `0.x` (or major release in `1.x` if breaking).

---

## 3. Per-Module Stability Tiers

Production readiness is declared **per module** based on real-infrastructure integration and fault-injection tests, never inferred solely from unit or conformance test counts. For the complete 19-package, 95-export subpath inventory and `0.1.x → 0.2.x → 1.0` deprecation rules, see [`docs/public-api-matrix.md`](./public-api-matrix.md).

| Stability Tier | Scope | Qualification Criteria |
| --- | --- | --- |
| **Production Preview (`0.1`)** | `@bunest/core` (HTTP, DI, Config), `@bunest/validation`, `@bunest/orm` (PostgreSQL via `Bun.SQL`, explicit migrations), `@bunest/observability` (logging, health, metrics) on **Linux** | Pinned Linux CI green, real PostgreSQL persistence/migration/outage/backup smoke suite, 2h soak gate, `< 5 min` rollback rehearsal, clean out-of-repo registry install. See [`docs/production-preview.md`](./production-preview.md). |
| **Beta (Integration-Verified)** | `@bunest/cache`, `@bunest/jobs`, `@bunest/security`, `@bunest/swagger`, `@bunest/testing`, `@bunest/cli`, `@bunest/resilience`, `@bunest/orm` (SQLite) | Full unit & conformance coverage + real-service integration tests (Redis / SQLite) in CI. |
| **Preview / Experimental** | `@bunest/graphql`, `@bunest/microservices`, `@bunest/messaging`, `@bunest/workflows`, `@bunest/storage`, `@bunest/mail`, `@bunest/elasticsearch`, `@bunest/ai`, non-PostgreSQL `Bun.SQL` dialects (MySQL/MariaDB/MongoDB/LibSQL/D1) | Functional with 100% conformance / unit tests; awaiting dedicated real-service fault-injection & soak verification before promotion. |

---

## 4. Security & Maintenance

- Security vulnerabilities are handled privately per [`SECURITY.md`](../SECURITY.md).
- Critical security fixes are patched on the latest minor release line immediately and published to npm with provenance (`--provenance`).
