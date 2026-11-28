# Bunest Support, Versioning & Stability Policy

This document defines Bunest's Semantic Versioning commitment, release & Bun runtime support matrix, LTS eligibility criteria, per-module stability tiers, security/patch SLAs, and the 2-consecutive-version upgrade verification policy.

---

## 1. Semantic Versioning (`SemVer`)

Bunest follows [Semantic Versioning 2.0.0](https://semver.org/):

- **`0.x.y` (Pre-1.0 / Production Preview & Minor Cycles)**:
  - Patch releases (`0.1.x`, `0.2.x`, ...) contain bug fixes, security patches, and backward-compatible improvements only. Existing apps on the same minor line must upgrade in place without code changes.
  - Minor releases (`0.2.0`, `0.3.0`, ...) may promote Beta/Preview modules and introduce controlled breaking changes, always backed by an ADR ([`docs/adr/`](./adr/README.md)), documented in [`CHANGELOG.md`](../CHANGELOG.md) with migration notes, and preceded by a deprecation cycle where practical.
- **`1.0.0+` (General Availability)**:
  - Public APIs exported via `package.json#exports` (inventoried in [`docs/public-api-matrix.md`](./public-api-matrix.md)) are strictly backward-compatible within a major version.
  - Breaking changes to Stable public exports occur only in major versions (`2.0.0`, ...) with codemods or migration guides.
  - Deprecated Stable APIs remain functional for **at least one minor release** (or **6 months** on LTS lines) before removal.

All 19 `@bunest/*` workspace packages are **lockstep-versioned** (every release publishes all 19 packages under the exact same version number with npm `--provenance`).

---

## 2. Release & Bun Runtime Support Matrix

Bunest is a **Bun-native** framework ([`ADR-017`](./adr/ADR-017.md)) and intentionally does not target Node.js or Deno.

| Bunest Line | Status | Minimum Bun | Pinned CI Runtime | Compatibility Matrix | Support Window & Backport Scope |
| --- | --- | --- | --- | --- | --- |
| **`0.1.x`** | **Production Preview** (Active) | `>= 1.4.5` | `1.4.5` (Linux `ubuntu-latest`, required) | `latest` on Linux, macOS, Windows | Active bug & security patches until `0.2.0` release + 30-day Critical security overlap; superseded by `0.2.x` (no backports once `0.2.x` is active per [`SECURITY.md`](../SECURITY.md)). |
| **`0.2.x`** | **Pre-1.0 Minor Cycle** (Planned) | `>= 1.4.5` *(minor bump allowed at `0.2.0` with release notes)* | Pinned Linux CI runtime (required) | `latest` on Linux, macOS, Windows | Active patch & security fixes until superseded by the next `0.x` minor or `1.0.0` GA. Serves as the primary bridge for pilot-driven module promotions and 2-consecutive-version upgrade verification. |
| **`1.0.x`** | **General Availability / LTS Candidate** (Target) | `>= 1.4.5` *(frozen minimum for `1.x` major)* | Pinned Linux CI runtime (required) | `latest` on Linux, macOS, Windows | **Active Support:** 12 months from `1.0.0` GA (bug fixes, backward-compatible features, all security patches). **Security-Only / LTS Maintenance:** +6 months (Critical & High security backports; Medium/Low evaluated case-by-case). |

### Runtime Rules

- **Pinned CI gate**: Every PR and release is gated on Linux + the pinned Bun version (`1.4.5` for `0.1.x`).
- **Forward tracking**: Bun `latest` is continuously tested in CI across Linux, macOS, and Windows so upstream Bun regressions are caught early.
- **Bumping minimum Bun version**: Raising `engines.bun` is forbidden in patch releases; it requires at least a minor release in `0.x` (with release notes) or a major release in `1.x` if breaking.

### LTS Eligibility Criteria

A release line (starting with `1.0.x`, or the designated final minor of a future `X.Y.x` major line) qualifies for **Long-Term Support (LTS)** only when **all** of the following criteria are met:

1. **Frozen Public API Surface**: All Stable `package.json#exports` across the 19 lockstep packages are frozen and documented in [`docs/public-api-matrix.md`](./public-api-matrix.md) with explicit owners and behavioral contracts.
2. **Independent Security Sign-Off**: Zero open **Critical** or **High** findings from the independent security review ([`docs/security.md`](./security.md#independent-security-review-scope-10-rc)), with verified regression tests for every remediated finding.
3. **2-Consecutive-Version Upgrade Proof**: Out-of-monorepo pilot apps have completed verified upgrades across two consecutive versions using real published artifacts (Section 5 below).
4. **Operational & Infrastructure Proof**: Pinned Linux CI green, real PostgreSQL smoke/restore passing, 2-hour steady-state soak (`p95 < 200 ms`, `5xx < 0.1%`, stable RSS), and `< 5 min` rolling rollback rehearsal documented.
5. **Sustained Maintainer & Provenance Commitment**: Designated maintainers committed to honoring [`SECURITY.md`](../SECURITY.md) backport SLAs and publishing all 19 packages with npm `--provenance`.

---

## 3. Per-Module Stability Tiers

Production readiness is declared **per module** based on real-infrastructure integration and fault-injection tests, never inferred solely from unit or conformance test counts. For the complete 19-package, 95-export subpath inventory, owner assignments, behavioral contracts, and `0.1.x → 0.2.x → 1.0` deprecation rules, see [`docs/public-api-matrix.md`](./public-api-matrix.md).

| Stability Tier | Scope | Qualification Criteria |
| --- | --- | --- |
| **Production Preview (`0.1`)** | `@bunest/core` (HTTP, DI, Config), `@bunest/validation`, `@bunest/orm` (PostgreSQL via `Bun.SQL`, explicit migrations), `@bunest/observability` (logging, health, metrics) on **Linux** | Pinned Linux CI green, real PostgreSQL persistence/migration/outage/backup smoke suite, 2h soak gate, `< 5 min` rollback rehearsal, clean out-of-repo registry install. See [`docs/production-preview.md`](./production-preview.md). |
| **Beta (Integration-Verified)** | `@bunest/cache`, `@bunest/jobs`, `@bunest/security`, `@bunest/swagger`, `@bunest/testing`, `@bunest/cli`, `@bunest/resilience`, `@bunest/orm` (SQLite) | Full unit & conformance coverage + real-service integration tests (Redis / SQLite) in CI. |
| **Preview / Experimental** | `@bunest/graphql`, `@bunest/microservices`, `@bunest/messaging`, `@bunest/workflows`, `@bunest/storage`, `@bunest/mail`, `@bunest/elasticsearch`, `@bunest/ai`, non-PostgreSQL `Bun.SQL` dialects (MySQL/MariaDB/MongoDB/LibSQL/D1) | Functional with 100% conformance / unit tests; awaiting dedicated real-service fault-injection & soak verification before promotion. |

---

## 4. Security & Patch SLAs

Security vulnerabilities are handled privately per [`SECURITY.md`](../SECURITY.md). Patch timelines and backport commitments are aligned 1:1 with [`SECURITY.md`](../SECURITY.md#severity-to-patch-sla):

| Severity | CVSS v3.1 / Criteria | Acknowledgement | Triage & Plan | Target Patch Release | Backport Scope (`1.0.0+` GA & LTS) |
| --- | --- | --- | --- | --- | --- |
| **Critical** | `9.0 – 10.0` (e.g., RCE, auth bypass in default config, arbitrary file read/write) | Within **24 hours** | Within **2 business days** | Within **7 days** (expedited out-of-band release) | Current major line + all active LTS lines |
| **High** | `7.0 – 8.9` (e.g., privilege escalation, JWT/session forgery, SSRF, SQLi, prototype pollution leading to authz bypass) | Within **48 hours** | Within **3 business days** | Within **14 days** | Current major line + all active LTS lines |
| **Medium** | `4.0 – 6.9` (e.g., scoped DoS, CSRF bypass under non-default settings, sensitive info leak in edge paths) | Within **48 hours** | Within **5 business days** | Within **30 days** (next scheduled patch release) | Current major line; LTS evaluated case-by-case |
| **Low** | `0.1 – 3.9` (e.g., defense-in-depth hardening, low-impact edge cases) | Within **5 business days** | Within **10 business days** | Next regular patch or minor release | Current major line; LTS evaluated case-by-case |

- **Pre-`1.0` (`0.x`) backports**: Security fixes are released immediately as patches on the latest active `0.x` minor line (e.g., `0.1.x`, then `0.2.x`) and published to npm with `--provenance`. Older `0.x` minor lines do not receive backports.
- **Non-security P0/P1 regressions**: Data-loss, transaction corruption, broken clean install, broken public imports, or failed in-place patch upgrades block release promotion until fixed, regression-tested, and re-verified on staging (see [Bunest Roadmap](../apps/docs/content/ecosystem/roadmap.md) §5).

---

## 5. 2-Consecutive-Version Upgrade Verification Policy

To ensure real users can upgrade safely across releases without hidden export, metadata, validation, or migration regressions, every minor release (`0.2.0+`) and `1.0` Release Candidate must pass **2-consecutive-version upgrade verification** before release sign-off (aligned with [Bunest Roadmap](../apps/docs/content/ecosystem/roadmap.md) §6, §9 Week 15, and §10).

### 5.1 Required Upgrade Chains

- **Pre-`1.0` Minor Gate (`0.2.0`)**: Upgrade an out-of-monorepo pilot app sequentially across two consecutive transitions, e.g.:
  `0.1.0` → `0.1.x` (latest patch) → `0.2.0-rc.*`
- **`1.0` GA Gate (`1.0.0`)**: Upgrade both Pilot A (greenfield REST API) and Pilot B (NestJS-migrated module) sequentially across two consecutive transitions, e.g.:
  `0.1.x` → `0.2.x` → `1.0.0-rc.*` (and `1.0.0-rc.*` → `1.0.0` upon final publish)

### 5.2 Real-Published-Artifact Provenance Rule ([Bunest Roadmap](../apps/docs/content/ecosystem/roadmap.md) §10)

> **Rule:** Same-checkout local tarball runs are **necessary for CI packaging checks, but never sufficient for release compatibility sign-off**.

- **Automated local harness (`bun run verify:upgrade-pilots`, [`scripts/verify-upgrade-and-pilots.ts`](../scripts/verify-upgrade-and-pilots.ts))**: Packs two tarball sets from the current checkout to validate `package.json#exports`, workspace dependency rewriting, scaffolded app upgrades, and NestJS-migrated SQLite module upgrades. This proves the packaging pipeline works, **not** backward compatibility against what users actually installed previously.
- **Real-artifact release proof (Mandatory for `0.1.x` → `0.2.x` → `1.0`)**: Before tagging a release, maintainers must execute the upgrade starting from the **real published artifacts** of the baseline version (installed from npm or the pinned staging registry used for that prior release) to the candidate artifacts (published to staging registry via [`scripts/verify-staging-registry.ts`](../scripts/verify-staging-registry.ts) or packed from the exact release commit).
- **Mandatory provenance record**: Every upgrade report (recorded in [`docs/release-ops-templates.md`](./release-ops-templates.md)) must explicitly log:
  1. **Old artifact source**: Registry URL (e.g., `https://registry.npmjs.org` or staging registry URL), exact `@bunest/*` version, tarball integrity/SHA, and originating commit SHA.
  2. **New artifact source**: Staging registry URL or tarball path, exact candidate version, and candidate commit SHA.
  3. **Execution environment**: Linux distro, exact Bun version (`bun --version`), and database version (PostgreSQL 17 / SQLite).
  4. **Observed deltas**: Compile/typecheck errors, runtime errors, DTO/HTTP behavior diffs, database migration & existing-data integrity checks, and total manual intervention time required.
