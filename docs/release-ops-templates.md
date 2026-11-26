# Bunest Release & Operations Templates

Ready-to-use operational templates aligned with [`docs/ke-hoach-phat-trien-bunest.md`](./ke-hoach-phat-trien-bunest.md) (Sections 8, 10, 11, and 12) and [`docs/production-preview.md`](./production-preview.md).

**Related references:**
- Production runbook & Go/No-Go gates: [`docs/production-preview.md`](./production-preview.md)
- 8-week & `1.0` development plan: [`docs/ke-hoach-phat-trien-bunest.md`](./ke-hoach-phat-trien-bunest.md)
- Support tiers & versioning policy: [`docs/support-policy.md`](./support-policy.md)
- 19-package public API inventory: [`docs/public-api-matrix.md`](./public-api-matrix.md)
- `0.1.x` baseline report: [`docs/baseline-0.1.x-report.md`](./baseline-0.1.x-report.md)
- Private security disclosure policy: [`SECURITY.md`](../SECURITY.md)

> **Usage rule:** Copy the relevant template into your weekly tracking issue, pilot sign-off record, release ticket, or budget doc. Every passing signal must trace back to an exact commit SHA, Bun version, artifact source, and log/report link.

---

## Template 1: Weekly Status & Evidence Ledger

Use at the **start of each week** to lock deliverables and at the **end of each week** to record verifiable gate results, open P0/P1 blockers, pilot feedback, and schedule updates.

```markdown
# Weekly Status & Evidence Ledger — Week <N> (<YYYY-MM-DD> to <YYYY-MM-DD>)

| Field | Value |
| --- | --- |
| **Release Candidate / Version** | `<e.g. 0.1.1-rc.1>` |
| **Commit SHA** | `<full-40-char-sha>` |
| **Bun Version** | `<e.g. 1.4.5>` |
| **Target OS / Environment** | `<e.g. Ubuntu 24.04 Linux x64 / staging VPS spec>` |
| **Owners** | Person A (Framework & DX): `<name>` · Person B (Data & Release): `<name>` |
| **Overall Status** | `ON TRACK` / `AT RISK` / `BLOCKED` |

### 1. Start-of-Week Commitments

| # | Deliverable | Owner | Recipient / Verifier | Prerequisites | Independent Verification Method | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `<deliverable>` | `<A/B>` | `<B/A or Pilot>` | `<prereq>` | `<command or runbook step>` | `DONE` / `IN PROGRESS` / `BLOCKED` |

### 2. Verification Gates & Evidence Ledger

> Record healthy steady-state load metrics separately from fault-injection metrics. If a service-backed check is skipped due to missing infrastructure, mark `SKIPPED` and state the reason explicitly.

| Gate | Command / Harness | Status | Key Result / Metric | Log / Report Link |
| --- | --- | --- | --- | --- |
| Frozen install | `bun install --frozen-lockfile` | `PASS` / `FAIL` | `<exit code, duration>` | `<CI or log URL>` |
| Typecheck | `bun run typecheck` | `PASS` / `FAIL` | `<0 errors>` | `<log URL>` |
| Build + `.d.ts` | `bun run build` | `PASS` / `FAIL` | `<19 pkgs + apps>` | `<log URL>` |
| Full test suite | `bun test` | `PASS` / `FAIL` | `<pass/skip/fail counts>` | `<log URL>` |
| NestJS conformance | `bun run conformance:gate` | `PASS` / `FAIL` | `<7005/7005, 0 skip, 0 fail>` | `<log URL>` |
| Generated AI docs | `bun run ai:docs --check` | `PASS` / `FAIL` | `<fresh>` | `<log URL>` |
| Release gate | `bun run verify:release` | `PASS` / `FAIL` | `<19/19 zero-dep, DAG ok>` | `<log URL>` |
| Pack & publish order | `bun run publish:dry-run` & `bun run verify:staging-plan` | `PASS` / `FAIL` | `<19/19 uniform version>` | `<log URL>` |
| Clean install (external) | `scripts/verify-staging-registry.ts` | `PASS` / `FAIL` | `<registry URL, TTFR>` | `<log URL>` |
| Automated upgrade | `bun run verify:upgrade-pilots` | `PASS` / `FAIL` | `<from-artifact -> to-artifact>` | `<log URL>` |
| Real PostgreSQL smoke | `bun run smoke:postgres` | `PASS` / `FAIL` / `SKIPPED` | `<PG version, /ready 200->503->200, restore ok>` | `<log URL>` |
| Real Redis smoke (if scoped) | `bun run smoke:redis` | `PASS` / `FAIL` / `SKIPPED` | `<Redis version, lease/retry result>` | `<log URL>` |
| 2h Load/Soak (healthy) | `examples/production-rest-postgres` load harness | `PASS` / `FAIL` / `SKIPPED` | `<p95 ms, 5xx %, RSS start/peak/end>` | `<load-report-2h.json>` |
| Rolling deploy & rollback | `deploy/rollback.sh` + fault injection | `PASS` / `FAIL` / `SKIPPED` | `<rollback time < 5 min, image tags>` | `<rollback report URL>` |

### 3. Open P0 / P1 Bugs & Blockers

| ID | Severity | Module / Package | Summary & Minimal Repro | Owner | Re-Run Gate After Fix | Status |
| --- | --- | --- | --- | --- | --- | --- |
| `<#id>` | `P0` / `P1` | `<@bunest/...>` | `<summary + repro link>` | `<name>` | `<targeted + full gate>` | `OPEN` / `IN REVIEW` / `VERIFIED` |

### 4. Pilot Feedback & Action Items

- **Pilot A (Greenfield):** `<summary of progress, friction, or blockers>`
- **Pilot B (NestJS Migration):** `<summary of progress, friction, or blockers>`
- **Docs / Code Follow-Ups:** `<ticket links>`

### 5. Dependency Gate & Schedule Changes

- **Linux CI 3x consecutive green:** `YES` / `NO` (`<links to 3 runs>`)
- **Schedule / scope adjustments:** `<none, or old date -> new date, reason, owner, downstream impact>`
```

---

## Template 2: Pilot A / Pilot B Intake & Sign-Off Report

Use once per pilot (`Pilot A` = greenfield REST API; `Pilot B` = NestJS module migration with controller, guard, validation, and database). Maintainers must log any step requiring assistance **before** intervening.

```markdown
# Pilot Intake & Sign-Off Report — Pilot <A / B>: <Project Name>

### 1. Intake & Environment Metadata

| Field | Value |
| --- | --- |
| **Pilot Track** | `Pilot A (Greenfield REST API)` / `Pilot B (NestJS Module Migration)` |
| **Pilot Engineer** | `<name / handle>` |
| **Maintainer Counterpart** | `<Person A / Person B>` |
| **Window (5 business days)** | `<YYYY-MM-DD> to <YYYY-MM-DD>` |
| **From Version / Source** | `<e.g. new project, NestJS 10.x, or @bunest/* 0.1.0 from npm>` |
| **To Candidate Version** | `<e.g. 0.1.1-rc.1>` |
| **Candidate Commit SHA** | `<full-40-char-sha>` |
| **Artifact Source** | `<staging registry URL / published registry / tarball path>` |
| **Runtime & Infra** | OS: `<Linux distro>` · Bun: `<1.4.5>` · DB: `<PostgreSQL 17 / SQLite>` |

### 2. Pre-Flight Dependency Check (Section 8)

- [ ] Linux required CI job passed **3 consecutive times** on the baseline/candidate branch (`<run links>`).
- [ ] Real PostgreSQL persistence, migration, and backup/restore checks passed (`<report link>`).
- [ ] Scope agreed (endpoints, guards/DTOs, DB schema, upgrade path, and repro repo/channel).

### 3. Time-to-First-Request (TTFR) & Lifecycle Measurements

| Milestone | Measured Time | Outcome | Notes |
| --- | --- | --- | --- |
| Clean install -> scaffold/migrate -> first `200`/`201` request (**TTFR**) | `<mm:ss>` | `PASS` / `FAIL` | `<command sequence used>` |
| Add controller/service/DTO (or migrate NestJS module) + `bun test` | `<mm:ss>` | `PASS` / `FAIL` | `<test count>` |
| Static & app verification (`bunest verify` / `bun run typecheck`) | `<mm:ss>` | `PASS` / `FAIL` | `<diagnostics observed>` |
| Deploy + health probes (`/live`, `/ready`) + graceful `SIGTERM` drain | `<mm:ss>` | `PASS` / `FAIL` | `<probe behavior>` |
| Upgrade (`from` -> `to`) with existing data & restart | `<mm:ss>` | `PASS` / `FAIL` | `<persistence & contract check>` |

### 4. Steps Requiring Maintainer Intervention

> Record every point where the pilot engineer could not proceed using only published docs (`docs/quickstart.md`, `docs/nestjs-migration.md`, `docs/production-preview.md`).

| # | Step / Doc Reference | Friction or Blocker Observed | Maintainer Intervention | Root Cause | Follow-Up Ticket (Code / EN+VI Docs) |
| --- | --- | --- | --- | --- | --- |
| 1 | `<step / doc link>` | `<what failed or was unclear>` | `<exact help given>` | `Code` / `Docs` / `Infra` | `<#ticket>` |

### 5. Observed Bugs & Reproduction Steps

| Bug ID | Severity | Affected Package / Flow | Minimal Repro Steps / Repo | Expected vs. Actual Behavior | Resolution / Release Decision |
| --- | --- | --- | --- | --- | --- |
| `<#id>` | `P0` / `P1` / `P2` / `P3` | `<@bunest/...>` | `<steps or minimal repo link>` | Expected: `<...>` · Actual: `<...>` | `<fix commit SHA or defer decision>` |

### 6. Post-Fix Re-Run & Sign-Off

| Field | Value |
| --- | --- |
| **Re-Run Candidate Version & Commit** | `<version>` · `<commit-sha>` |
| **Re-Run Date** | `<YYYY-MM-DD>` |

- [ ] Every P0/P1 bug blocking this pilot has a merged fix or explicit release-hold decision.
- [ ] The pilot engineer independently re-ran all previously failing flows on the fixed candidate without maintainer intervention.
- [ ] Quickstart / migration guide / runbook updates are merged in lockstep (EN & VI).

| Role | Name | Decision | Date |
| --- | --- | --- | --- |
| **Pilot Engineer** | `<name>` | `APPROVED` / `HOLD` | `<YYYY-MM-DD>` |
| **Person A (Framework & DX)** | `<name>` | `APPROVED` / `HOLD` | `<YYYY-MM-DD>` |
| **Person B (Data & Release)** | `<name>` | `APPROVED` / `HOLD` | `<YYYY-MM-DD>` |
```

---

## Template 3: Release-Day, Week-1 & Month-1 Post-Release Ops Checklist

Use for every `0.1.x` / `0.2.x` / `1.0` release to verify registry integrity on release day, track production telemetry during Week 1, and close the feedback loop at Month 1.

```markdown
# Release & Post-Release Ops Checklist — Bunest v<X.Y.Z>

| Field | Value |
| --- | --- |
| **Version & Git Tag** | `v<X.Y.Z>` |
| **Approved Commit SHA** | `<full-40-char-sha>` |
| **Target Registry** | `<https://registry.npmjs.org>` |
| **Release Coordinator (Person B)** | `<name>` |
| **API & Docs Verifier (Person A)** | `<name>` |
| **Release Date** | `<YYYY-MM-DD>` |

---

### Phase A: Release-Day Verification (Before Public Announcement)

#### 1. 19-Package Registry Completeness Check (Person B)
- [ ] All 19 `@bunest/*` packages are present on the target registry at exact version `<X.Y.Z>` (verify against `docs/public-api-matrix.md` and `bun run verify:staging-plan`; zero missing or mismatched versions).
- [ ] If publish was interrupted mid-run, audited present versions and completed recovery per `.github/workflows/release.yml` before proceeding.
- [ ] Zero `workspace:*` specifiers or raw `./src/*.ts` export leaks in published tarballs.

#### 2. Clean Install Outside Monorepo & Upgrade Verification (Person B)
- [ ] Created an empty directory outside the monorepo (0 workspace symlinks, clean cache) and installed `@bunest/cli@<X.Y.Z>` from the target registry.
- [ ] Ran `bunest new`, `bun install`, `bun run typecheck`, `bun test`, `bun run verify`, and verified live HTTP (`200`/`201`/`400` DTO validation).
- [ ] Upgraded a reference/pilot app from the previous published version (`<X.Y.(Z-1)>`) to `<X.Y.Z>` using real registry artifacts; verified persistence and behavior.

#### 3. Public Import, Types & EN/VI Docs Check (Person A)
- [ ] Verified public root/subpath imports and strict `tsc --noEmit` (`.d.ts`) against the published packages.
- [ ] Cross-checked `CHANGELOG.md`, GitHub Release Notes (changes, known limitations, and rollback instructions), `docs/quickstart.md`, `docs/nestjs-migration.md`, `docs/support-policy.md`, and EN/VI roadmap pages (`apps/docs/content/ecosystem/roadmap.md`, `apps/docs/content-vi/ecosystem/roadmap.md`) against `<X.Y.Z>`.
- [ ] **Announcement Gate:** All checks above passed — release announced on `<YYYY-MM-DD HH:MM UTC>`.

---

### Phase B: Week-1 Post-Release Monitoring (Days 1–7)

- **Person A (Framework & DX):** Triage incoming install, upgrade, public import, and behavioral-regression reports.
- **Person B (Data & Release):** Track pilot & staging telemetry against `docs/production-preview.md` thresholds (`p95 < 200 ms`, `5xx < 0.1%`, stable RSS with no monotonic growth, `/live` & `/ready` recovery, rollback `< 5 min`).

| Day / Date | Active Pilots | 5xx Rate (`< 0.1%`) | p95 Latency (`< 200 ms`) | RSS Trend (Stable?) | Regressions / Incidents | Owner |
| --- | --- | --- | --- | --- | --- | --- |
| Day 1 (`<date>`) | `<count>` | `<0.00%>` | `<ms>` | `<stable / growing>` | `<none or #id>` | `<A/B>` |
| Day 3 (`<date>`) | `<count>` | `<0.00%>` | `<ms>` | `<stable / growing>` | `<none or #id>` | `<A/B>` |
| Day 7 (`<date>`) | `<count>` | `<0.00%>` | `<ms>` | `<stable / growing>` | `<none or #id>` | `<A/B>` |

**Regression Handling Protocol (if any issue is reported):**
- [ ] Reproduced against the exact published version `<X.Y.Z>` outside the monorepo.
- [ ] Identified all affected version(s) and classified severity (`P0`–`P3`).
- [ ] Added regression test and prepared patch `<X.Y.(Z+1)>` through the full release gate pipeline.

---

### Phase C: Month-1 Retrospective & Security Escalation (Day 30)

#### 1. Operational Metrics Review

| Metric | Target / Baseline | Observed (Month 1) | Evidence / Notes |
| --- | --- | --- | --- |
| Median Time-to-First-Request (TTFR) | `<baseline>` | `<observed>` | `<pilot / quickstart logs>` |
| Maintainer interventions per pilot | `0` (docs self-serve) | `<count>` | `<top friction step>` |
| Upgrade failures reported | `0` | `<count>` | `<issue links>` |
| Verified rollback duration | `< 5 min` | `<mm:ss>` | `<rehearsal / incident log>` |
| Open bugs by module | — | Core: `<n>` · Val: `<n>` · ORM/PG: `<n>` · CLI: `<n>` · Obs: `<n>` · Docs: `<n>` | `<tracker link>` |

#### 2. Next-Cycle Prioritization
- **Top user time-sink identified:** `<description>`
- **Selected scope for next minor/patch cycle:** `<single focused workflow with confirmed pilot, maintainer, and real-infra test plan>`

#### 3. Security Escalation Check
- [ ] Confirmed zero unresolved security reports outside private channels.
- [ ] Any suspected vulnerability was escalated strictly via [`SECURITY.md`](../SECURITY.md) (GitHub Security Advisories or `security@bunest.dev`, with PGP fallback; per-severity SLAs — Critical: 24h ack / 2d triage / 7d patch; High: 48h ack / 3d triage / 14d patch; Medium: 48h ack / 5d triage / 30d patch; Low: 5d ack / 10d triage / next release; up to 90-day coordinated embargo — never public GitHub issues).
```

---

## Template 4: Capacity, Staging Cost & `1.0` Security Audit Scoping Worksheet

Use at **Week 0 / Week 1** to lock capacity and staging budget inputs, and before **API Freeze (Week 16 / pre-`1.0` RC)** to scope and approve the independent security audit.

```markdown
# Capacity, Staging Cost & `1.0` Security Audit Scoping Worksheet

| Field | Value |
| --- | --- |
| **Planning Cycle** | `<e.g. 8-Week 0.1.x Preview -> 1.0 Prep>` |
| **Last Updated** | `<YYYY-MM-DD>` |
| **Owners** | Person A (Scope & Audit): `<name>` · Person B (Infra & Staging Budget): `<name>` |

---

### Part A: 8-Week Capacity Plan (80 Person-Days Baseline)

> Baseline assumes **2 full-time engineers x 8 weeks = 80 person-days** before holidays/PTO. Recalibrate at the **end of Week 1** based on actual availability and baseline bug findings. If running solo, preserve milestone order and defer Redis to the next cycle.

| Workstream | Baseline Allocation | Share | Holidays / PTO Adjustment | Net Planned | Actual Spent (W1–W8) | Variance & Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Implementation & Testing | `48` person-days | 60% | `<e.g. -2>` | `<days>` | `<days>` | `<notes>` |
| Staging, Pilot & Release Ops | `16` person-days | 20% | `<e.g. -1>` | `<days>` | `<days>` | `<notes>` |
| Bug Fixes, Regressions & Review | `16` person-days | 20% | `<e.g. -1>` | `<days>` | `<days>` | `<notes>` |
| **Total** | **`80` person-days** | **100%** | **`<adj>`** | **`<net>`** | **`<actual>`** | **Week-1 recalibration date: `<YYYY-MM-DD>`** |

---

### Part B: Staging & Release Infrastructure Cost Inputs (Owner: Person B)

> Pin hardware specs and load parameters so 2h soak reports remain comparable across candidates.

| Cost Category | Provider & Spec / Sizing | Usage Window | Unit Rate | Estimated Total | Status |
| --- | --- | --- | --- | --- | --- |
| **Staging Linux VPS** (2 API instances + Caddy + load runner) | `<e.g. 4 vCPU, 8 GB RAM, Ubuntu 24.04>` | `<e.g. 2 months>` | `<$/mo>` | `<$>` | `ESTIMATE` / `APPROVED` |
| **PostgreSQL 17** (managed or dedicated volume) | `<e.g. PG 17, 2 vCPU, 4 GB RAM, 50 GB SSD>` | `<e.g. 2 months>` | `<$/mo>` | `<$>` | `ESTIMATE` / `APPROVED` |
| **Redis** (optional — only if Redis branch is evaluated) | `<e.g. Redis 7.x single node>` | `<e.g. 1 month>` | `<$/mo>` | `<$>` | `DEFERRED` / `APPROVED` |
| **Backup & Report Storage** (`pg_dump` backups, commit-tagged soak/CI logs) | `<e.g. S3/R2 100 GB>` | `<e.g. 6 months>` | `<$/mo>` | `<$>` | `ESTIMATE` / `APPROVED` |
| **Staging / Private Registry** (if paid; `$0` if self-hosted Verdaccio) | `<e.g. Verdaccio on staging VPS>` | `<e.g. 2 months>` | `<$/mo>` | `<$>` | `ESTIMATE` / `APPROVED` |
| **Domain / TLS / Monitoring** (if applicable) | `<e.g. staging DNS + metrics retention>` | `<e.g. 2 months>` | `<$/mo>` | `<$>` | `ESTIMATE` / `APPROVED` |
| **Subtotal — Staging & Ops** | — | — | — | **`<$>`** | — |

---

### Part C: `1.0` Independent Security Audit Scoping Worksheet (Owner: Person A)

> Must be scoped, budgeted, and scheduled **before** announcing the `1.0` Release Candidate date. All findings are handled privately per [`SECURITY.md`](../SECURITY.md).

#### 1. Audit Scope (Aligned with `docs/public-api-matrix.md` & `SECURITY.md`)

| Surface / Package | Security Properties to Audit | Included in `1.0` Audit? |
| --- | --- | --- |
| `@bunest/core` & `@bunest/core/http` | Routing, `bodyLimit` (`413`), malformed JSON (`400`), prototype pollution defense, `trustProxy`, CORS allowlists, production error redaction, graceful shutdown | `YES` |
| `@bunest/validation` | `ValidationPipe` defaults (`whitelist`, `forbidNonWhitelisted`, `forbidUnknownValues`), nested DTO validation, sensitive value redaction | `YES` |
| `@bunest/orm` | PostgreSQL `Bun.SQL` query parameterization, transaction/savepoint isolation, migration safety | `YES` |
| `@bunest/security` | WebCrypto `JwtService` (constant-time verify, `alg: "none"` & key-confusion defense), `Bun.password` (`argon2id`), `SessionCookieService`, `CsrfGuard`, `ThrottlerGuard`, `SecurityHeadersMiddleware` | `YES` |
| `@bunest/storage` & `@bunest/storage/local` | `LocalStorageAdapter` two-layer path-traversal containment (`assertSafeStorageKey()` rejecting `..`, `.`, null/control bytes, absolute paths, drive prefixes, and NTFS ADS) | `YES` |
| `@bunest/observability` | Structured log secret redaction, `DevtoolsModule` production gate (`/_devtools/*` disabled in prod), `/metrics` access control | `YES` |
| `@bunest/core/config` | `.env` parsing, merge safety, prototype pollution defense | `YES` |
| Packaging & Supply Chain | 19-package publish pipeline (`scripts/publish-packages.ts`), zero external runtime dependencies (ADR-017), reproducible lockfile/CI release workflow | `YES` |
| Out-of-Scope / Preview Modules | `<list non-1.0 preview modules per docs/support-policy.md>` | `NO (explicitly excluded)` |

#### 2. Audit Logistics, Budget & Timeline

| Item | Detail |
| --- | --- |
| **Target Commit / API Freeze Date** | `<YYYY-MM-DD>` |
| **Selected Auditor / Firm** | `<name / TBD>` |
| **Estimated Audit Budget** | `<$>` (`QUOTE PENDING` / `APPROVED`) |
| **Audit Execution Window** | `<YYYY-MM-DD> to <YYYY-MM-DD>` |
| **Private Disclosure & Triage Channel** | [`SECURITY.md`](../SECURITY.md) (GitHub Security Advisories / `security@bunest.dev`) |
| **Remediation & Re-Test Window** | `<YYYY-MM-DD> to <YYYY-MM-DD>` |
| **Expected Deliverables** | Written findings report (severity-classified), remediation verification sign-off, publishable summary |
| **`1.0` RC Gate Condition** | All critical/high/release-blocking findings remediated, re-tested, and verified on candidate commit |

#### 3. Budget & Scope Sign-Off

| Role | Name | Scope / Budget Sign-Off | Date |
| --- | --- | --- | --- |
| **Person A (Framework & Audit Scope)** | `<name>` | `APPROVED` / `PENDING` | `<YYYY-MM-DD>` |
| **Person B (Staging Infra & Release)** | `<name>` | `APPROVED` / `PENDING` | `<YYYY-MM-DD>` |
| **Budget Approver** | `<name>` | `APPROVED` / `PENDING` | `<YYYY-MM-DD>` |
| **Independent Auditor Lead** | `<name>` | `CONFIRMED` / `PENDING` | `<YYYY-MM-DD>` |
```
