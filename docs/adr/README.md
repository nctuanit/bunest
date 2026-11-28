# Bunest Architecture Decision Records (ADRs)

This directory contains the authoritative architectural contracts for **Bunest** (a NestJS-style backend framework built natively on Bun). All 19 workspace packages (`@bunest/core`, `@bunest/validation`, `@bunest/security`, `@bunest/testing`, and ecosystem modules) MUST conform to these decisions.

## RFCs

| ID                                               | Title                                                            | Status   |
| ------------------------------------------------ | ---------------------------------------------------------------- | -------- |
| [RFC-001](../rfcs/RFC-001-controller-routing.md) | NestJS-Style Controller Routing & Compile-at-Bootstrap Execution | Accepted |

## ADR Index

### Runtime, TypeScript & Decorator Foundations

| ADR                     | Decision                                                                                                                              | Status   | Date       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------- |
| [ADR-001](./ADR-001.md) | Bun-Only Runtime (`>= 1.4.3` initial baseline; raised to `>= 1.4.5` by [ADR-016](./ADR-016.md), zero Express/Fastify/Node HTTP in core) | Accepted | 2026-11-20 |
| [ADR-002](./ADR-002.md) | Legacy TypeScript Decorators (`experimentalDecorators`, `emitDecoratorMetadata`, `verbatimModuleSyntax: true` + value-import classes) | Accepted | 2026-11-20 |

### Routing & Parameter Binding

| ADR                     | Decision                                                                                          | Status   | Date       |
| ----------------------- | ------------------------------------------------------------------------------------------------- | -------- | ---------- |
| [ADR-003](./ADR-003.md) | NestJS-Style Controllers + Method Decorators (stateless singleton default)                        | Accepted | 2026-11-20 |
| [ADR-004](./ADR-004.md) | Legacy Parameter Decorators Replacing `static parameters` (index-keyed, cached body parsing)      | Accepted | 2026-11-20 |
| [ADR-006](./ADR-006.md) | `@Controller()` Class Decorator, HTTP Method Decorators & Controller Scanner Contract             | Accepted | 2026-11-20 |
| [ADR-010](./ADR-010.md) | Response Serialization Contract, Default Status Codes (`POST -> 201`) & Response Decorators       | Accepted | 2026-11-20 |
| [ADR-011](./ADR-011.md) | `Bun.serve({ routes })` Native Routes Support Matrix (Bun 1.4.3) & Controlled Fallback Dispatcher | Accepted | 2026-11-20 |

### Dependency Injection & Modules

| ADR                     | Decision                                                                                                  | Status   | Date       |
| ----------------------- | --------------------------------------------------------------------------------------------------------- | -------- | ---------- |
| [ADR-007](./ADR-007.md) | Module-Scoped Providers, Export Visibility, Re-Exports, Dynamic & Global Modules                          | Accepted | 2026-11-20 |
| [ADR-012](./ADR-012.md) | Request-Scoped DI Propagation (`AsyncLocalStorage` / `RequestContainer`) & Fail-Fast Scope-Leak Detection | Accepted | 2026-11-20 |

### Validation & HTTP Execution Pipeline

| ADR                     | Decision                                                                                                                        | Status   | Date       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------- |
| [ADR-005](./ADR-005.md) | `class-validator` + `class-transformer` as Default DTO Validation (`PipeTransform` seam)                                        | Superseded by ADR-015 | 2026-11-20 |
| [ADR-008](./ADR-008.md) | Exact 11-Stage HTTP Execution Pipeline Order & Precedence Rules                                                                 | Accepted | 2026-11-20 |
| [ADR-009](./ADR-009.md) | Default `ValidationPipe` Options (`whitelist`, `forbidNonWhitelisted`, `forbidUnknownValues`) & Normalized HTTP 400 JSON Format | Accepted | 2026-11-20 |
| [ADR-013](./ADR-013.md) | NestJS v12.5.1 API Parity Contract, Built-in HTTP Security & Graph Inspection                                                   | Accepted | 2026-11-20 |
| [ADR-014](./ADR-014.md) | Service-Layer Method Aspect Weaving, Declarative Decorators & Compiled-Once Repositories                                        | Accepted | 2026-11-20 |
| [ADR-015](./ADR-015.md) | Bun-Native `@bunest/class-validator` & `@bunest/class-transformer` (Zero External Deps, Compile-Once DTO Engine)                | Accepted | 2026-11-22 |
| [ADR-016](./ADR-016.md) | 37 → 19 Package Consolidation (6 Domains, ESM Subpath Exports) & Bun 1.4.5 Native API Alignment                                 | Accepted | 2026-11-22 |
| [ADR-017](./ADR-017.md) | Zero External Runtime Dependencies (19/19 Packages) & Repo-Wide 2-Adapter `node:*` Kernel Quarantine                            | Accepted (Completed) | 2026-11-23 |
| [ADR-018](./ADR-018.md) | Customizable Magic Architecture: Unified `Bun.plugin`, Extensible Macros, Repository Scopes/Operators, AOP Phases/Pointcuts, Typegen & Diagnostic Plugins, Conditional `@AutoModule` | Accepted | 2026-11-23 |
| [ADR-019](./ADR-019.md) | Native Bun Workers Integration (`@bunest/jobs/workers`, Zero `node:worker_threads`, Sandboxed Queues, AOP `@Offload`, CLI Bundling & `reusePort` Clustering) | Accepted | 2026-11-28 |
| [ADR-020](./ADR-020.md) | Full Bun 1.4.5 Native Runtime API Alignment (`Bun.serve` Hot Paths, `Bun.Cookie`, Async Zstd, `Bun.JSONL`/`JSON5`, `Bun.Image`, `Bun.Archive`, `Bun.markdown`, `Bun.FetchSession`, `bun:jsc`, `Bun.secrets`, `Bun.udpSocket`) | Accepted | 2026-11-28 |

---

## Governance

- Any breaking change to a core contract (`@bunest/core`, `@bunest/validation`, `@bunest/security`) MUST add a new ADR (or mark the superseded ADR as `Superseded by ADR-NNN`) explaining context, decision, trade-offs, and migration impact.
- Implementation tests in `@bunest/*` MUST cross-reference and enforce the normative invariants (`MUST` / `MUST NOT`) locked in these ADRs.
