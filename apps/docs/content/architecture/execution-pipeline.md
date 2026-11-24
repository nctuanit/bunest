# 11-Stage Execution Pipeline

Every HTTP request handled by Bunest flows through a **single, deterministic 11-stage execution pipeline** locked by **[ADR-008](/architecture/adrs)**. Whether a request matches Bun's native Zig `Bun.serve({ routes })` table or the controlled Fallback Radix Router, it executes the exact same `CompiledExecutionPlan` closure.

## Interactive Pipeline Explorer

Click any stage below to inspect its exact execution order, short-circuit rules, and architectural contract:

@@component(pipeline-diagram)

## Canonical Sequence

```text
Incoming Request
  1. Route Match (Bun.serve native routes OR fallback dispatcher -> 404/405)
  2. RequestContext Init (+ AsyncLocalStorage / RequestContainer if scoped)
  ── Exception Filter Boundary begins ──────────────────────────────────────────
  3. Security / CORS Pre-Processing (preflight short-circuit, payload limits, IP)
  4. Middleware (Global -> Module-bound matching path/method)
  5. Guards (Global -> Controller -> Method)
  6. Interceptors [Before] (Global -> Controller -> Method)    ──┐
  7. Parameter Extraction (by ascending ParameterMetadata.index)│ Onion wrapped
  8. Pipes & Validation (Global -> Controller -> Method -> Param)│ by CallHandler
  9. Controller Handler (await controller[handlerKey](...args)) │ .handle()
 10. Interceptors [After] (Method -> Controller -> Global)     ──┘
 11. Response Serialization (ADR-010 + CORS/cookies/headers merge)
  ── Exception Filter Boundary catches throws from stages 3–11 (and 404/405) ──
  -> Exception Filters (Method -> Controller -> Global -> DefaultExceptionFilter)
  -> Native Web Response (with CORS headers preserved)
```

## Precedence Rules Matrix

| Mechanism                 | Execution Order                                           | Short-Circuit / Override Semantics                                             |
| ------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **Middleware**            | Global &rarr; Module (topological order)                  | Returning `Response` or throwing stops downstream stages                       |
| **Guards**                | Global &rarr; Controller &rarr; Method                    | All must pass; first `false` (403) or throw stops pipeline before body parsing |
| **Interceptors (before)** | Global &rarr; Controller &rarr; Method                    | Outer wraps inner; skipping `next.handle()` bypasses handler                   |
| **Pipes**                 | Global &rarr; Controller &rarr; Method &rarr; Parameter   | Chained sequentially per parameter (`v0 -> p1 -> p2 -> ... -> vn`)             |
| **Interceptors (after)**  | Method &rarr; Controller &rarr; Global                    | Inner unwinds and transforms result before outer                               |
| **Exception Filters**     | **Method &rarr; Controller &rarr; Global &rarr; Default** | **Most-specific first**; first `@Catch(...)` `instanceof` match wins           |

## Compile-at-Bootstrap Hot Path

At startup, Bunest resolves all DI-aware enhancers (`@UseGuards(AuthGuard)`, `APP_GUARD`, `APP_PIPE`, `APP_INTERCEPTOR`, `APP_FILTER`), pre-binds matching `MiddlewareConsumer` chains, merges `design:paramtypes` with `ParameterMetadata`, and freezes a route closure.

- **Zero `Reflect.getMetadata()` calls per request** on the hot path.
- **Zero `RequestContainer` allocations** on pure-singleton routes (`requiresRequestScope === false`).
- **Guaranteed CORS preservation** on both normal responses and Exception Filter error responses.
