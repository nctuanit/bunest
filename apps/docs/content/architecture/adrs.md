# ADR & RFC Index

Bunest's core architecture is governed by authoritative **Architecture Decision Records (ADRs)** and **RFCs** stored under `docs/adr/` and `docs/rfcs/` in the repository. All 19 packages across the monorepo conform to and test against these normative invariants.

## RFCs

| ID          | Title                                                            | Status   | Docs Guide                           |
| ----------- | ---------------------------------------------------------------- | -------- | ------------------------------------ |
| **RFC-001** | NestJS-Style Controller Routing & Compile-at-Bootstrap Execution | Accepted | [Controllers](/overview/controllers) |

## Runtime, TypeScript & Decorator Foundations

| ADR         | Decision Summary                                                                                                                      | Status   | Date       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------- |
| **ADR-001** | Bun-Only Runtime (`>= 1.4.3`, zero Express/Fastify/Node HTTP in core)                                                                 | Accepted | 2026-11-20 |
| **ADR-002** | Legacy TypeScript Decorators (`experimentalDecorators`, `emitDecoratorMetadata`, `verbatimModuleSyntax: true` + value-import classes) | Accepted | 2026-11-20 |

## Routing & Parameter Binding

| ADR         | Decision Summary                                                                                  | Status   | Guide                                                          |
| ----------- | ------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------- |
| **ADR-003** | NestJS-Style Controllers + Method Decorators (stateless singleton default)                        | Accepted | [Controllers](/overview/controllers)                           |
| **ADR-004** | Legacy Parameter Decorators Replacing `static parameters` (index-keyed, cached body parsing)      | Accepted | [Controllers](/overview/controllers)                           |
| **ADR-006** | `@Controller()` Class Decorator, HTTP Method Decorators & Controller Scanner Contract             | Accepted | [Controllers](/overview/controllers)                           |
| **ADR-010** | Response Serialization Contract, Default Status Codes (`POST -> 201`) & Response Decorators       | Accepted | [Response Serialization](/architecture/response-serialization) |
| **ADR-011** | `Bun.serve({ routes })` Native Routes Support Matrix (Bun 1.4.3) & Controlled Fallback Dispatcher | Accepted | [Hybrid Router](/architecture/hybrid-router)                   |

## Dependency Injection & Modules

| ADR         | Decision Summary                                                                                          | Status   | Guide                                              |
| ----------- | --------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------- |
| **ADR-007** | Module-Scoped Providers, Export Visibility, Re-Exports, Dynamic & Global Modules                          | Accepted | [Modules](/overview/modules)                       |
| **ADR-012** | Request-Scoped DI Propagation (`AsyncLocalStorage` / `RequestContainer`) & Fail-Fast Scope-Leak Detection | Accepted | [Injection Scopes](/fundamentals/injection-scopes) |

## Validation, HTTP Pipeline, Parity & Service-Layer AOP

| ADR         | Decision Summary                                                                                                                                                                          | Status   | Guide                                                        |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------ |
| **ADR-005** | `class-validator` + `class-transformer` as Default DTO Validation (`PipeTransform` seam)                                                                                                  | Superseded by ADR-015 | [Validation](/techniques/validation)                         |
| **ADR-008** | Exact 11-Stage HTTP Execution Pipeline Order & Precedence Rules                                                                                                                           | Accepted | [Execution Pipeline](/architecture/execution-pipeline)       |
| **ADR-009** | Default `ValidationPipe` Options (`whitelist`, `forbidNonWhitelisted`, `forbidUnknownValues`) & Normalized HTTP 400 JSON Format                                                           | Accepted | [Validation](/techniques/validation)                         |
| **ADR-013** | NestJS v12.5.1 API Parity Contract, Built-in HTTP Security & Graph Inspection                                                                                                               | Accepted | [Migration from NestJS](/architecture/migration-from-nestjs) |
| **ADR-014** | Service-Layer Method Aspect Weaving, Declarative Decorators (`@Transactional`, `@Cacheable`, `@Span`, `@EmitEvent`, `@WithLock`, `@Retry`, `@UseMiddleware`) & Compiled-Once Repositories | Accepted | [Service-Layer AOP](/techniques/service-aop)                 |
| **ADR-015** | Bun-Native DTO Validation & Transformation Engine (Zero External Deps, Compile-Once Plan)                                                                                                  | Accepted | [Validation](/techniques/validation)                         |
| **ADR-016** | 37 → 19 Package Consolidation (6 Domains, ESM Subpath Exports) & Bun 1.4.5 Native API Alignment                                                                                            | Accepted | [Packages & Monorepo](/ecosystem/packages)                   |
| **ADR-017** | Zero External Runtime Dependencies (19/19 Packages) & Repo-Wide 2-Adapter `node:*` Kernel Quarantine                                                                                      | Accepted (Completed) | [Packages & Monorepo](/ecosystem/packages)                   |
| **ADR-018** | Customizable Magic Architecture: Unified `Bun.plugin`, Extensible Macros, Repository Scopes/Operators, AOP Phases/Pointcuts, Typegen & Diagnostic Plugins, Conditional `@AutoModule`      | Accepted | [CLI & `bunest.config.ts`](/observability/cli)               |

## Governance Rules

- Any breaking change to a core contract (`@bunest/core`, `@bunest/validation`, `@bunest/security`) MUST introduce a new ADR (or mark the superseded ADR as `Superseded by ADR-NNN`) documenting context, trade-offs, and migration impact.
- Implementation tests in `@bunest/*` directly cross-reference and enforce the `MUST` / `MUST NOT` invariants locked in these records.
